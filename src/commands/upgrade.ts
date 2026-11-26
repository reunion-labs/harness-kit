import { format } from "node:util";
import pkg from "../../package.json";
import { harnessInvocation } from "../harness-cli";
import { doctorCmd } from "./doctor";
import { verifyCmd } from "./verify";
import { UPGRADE_HOOKS_NOTE, upgradeRepository, type UpgradeReport } from "../upgrade";
import { err, info, ok, warn } from "../util";

export interface UpgradeCmdOptions {
  check?: boolean;
  json?: boolean;
}

interface CapturedOutput {
  exitCode: number;
  output: string;
  error?: string;
}

function captureOutput(run: () => number): CapturedOutput {
  const chunks: string[] = [];
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  console.log = (...args: unknown[]) => {
    chunks.push(`${format(...args)}\n`);
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { exitCode: run(), output: chunks.join("") };
  } catch (error) {
    return { exitCode: 1, output: chunks.join(""), error: (error as Error).message };
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
}

function runJsonVerification(repo: string, report: UpgradeReport): number {
  const doctor = captureOutput(() => doctorCmd(repo, { details: true }));
  const verify = captureOutput(() => verifyCmd(repo, { json: true, details: true, recordManualEvidence: false }));
  let verifyReport: unknown;
  try {
    verifyReport = JSON.parse(verify.output);
  } catch {
    verifyReport = undefined;
  }
  report.verification = {
    doctor: { exitCode: doctor.exitCode, output: doctor.output, ...(doctor.error ? { error: doctor.error } : {}) },
    verify:
      verifyReport === undefined
        ? { exitCode: verify.exitCode, output: verify.output, ...(verify.error ? { error: verify.error } : {}) }
        : { exitCode: verify.exitCode, report: verifyReport, ...(verify.error ? { error: verify.error } : {}) },
  };
  if (doctor.exitCode !== 0 || verify.exitCode !== 0) {
    report.status = "incomplete";
    report.errors.push("post-upgrade doctor or verify failed");
    return 1;
  }
  return 0;
}

function hookLines(report: UpgradeReport, planned: boolean): void {
  const hooks = report.hooks;
  if (!hooks) {
    if (!planned)
      info(
        `No Harness lifecycle hooks are installed here; the optional session gate is added with ` +
          `\`${harnessInvocation(report.toVersion)} install-hooks --repo . --stop --agents <client>\`.`,
      );
    return;
  }
  const agents = hooks.agents.join(",");
  if (hooks.status === "refreshed")
    info(
      planned
        ? `Lifecycle hooks (${agents}): the managed runner and client configs are refreshed in the same transaction.`
        : `Lifecycle hooks (${agents}): refreshed in place. The next Stop through the new runner rebinds a session that started before ` +
            "the upgrade, so deliver and finish this turn to prove hookActive; third-party hook edits still need a fresh session.",
    );
  else if (hooks.status === "current") info(`Lifecycle hooks (${agents}): already current.`);
  else warn(`Lifecycle hooks (${agents}): not refreshed here (${hooks.reason}); run \`${hooks.command}\` after the upgrade.`);
}

function printHumanReport(report: UpgradeReport): void {
  if (report.status === "blocked") {
    for (const message of report.errors) err(message);
    return;
  }
  if (report.status === "upgrade-available") {
    // --check exits 2 here: "upgrade available" is a result, not a failure.
    warn(`upgrade available: ${report.fromVersion ?? "untracked"} -> ${report.toVersion} (exit 2 = upgrade available, not an error)`);
    if (report.pendingMigrations.length) info(`Pending migrations: ${report.pendingMigrations.join(", ")}`);
    if (report.changedFiles.length) info(`Files to update: ${report.changedFiles.join(", ")}`);
    hookLines(report, true);
    for (const note of report.notes) if (note !== UPGRADE_HOOKS_NOTE) info(note);
    if (report.dirtyFiles.length) warn("apply is blocked until the target Git scope is clean");
    return;
  }
  if (report.status === "current") {
    ok(`repository is current at ${report.toVersion}`);
    return;
  }
  ok(`upgraded repository: ${report.fromVersion ?? "untracked"} -> ${report.toVersion}`);
  for (const path of report.changedFiles) ok(`wrote ${path}`);
  for (const note of report.notes) if (note !== UPGRADE_HOOKS_NOTE) warn(note);
  hookLines(report, false);
}

export function upgradeCmd(repo: string, options: UpgradeCmdOptions = {}): number {
  const report = upgradeRepository(repo, {
    packageName: pkg.name,
    targetVersion: pkg.version,
    check: options.check,
  });
  if (options.json) {
    let code = report.status === "blocked" ? 1 : report.status === "upgrade-available" ? 2 : 0;
    if (!options.check && (report.status === "upgraded" || report.status === "current"))
      code = runJsonVerification(repo, report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return code;
  }

  printHumanReport(report);
  if (report.status === "blocked") return 1;
  if (report.status === "upgrade-available") return 2;
  if (options.check) return 0;
  // Compact like a plain run: on-demand boundaries stay folded (--details expands them).
  info("\nRunning post-upgrade doctor ...");
  const doctorCode = doctorCmd(repo);
  info("\nRunning post-upgrade verify ...");
  const verifyCode = verifyCmd(repo, { recordManualEvidence: false });
  if (doctorCode !== 0 || verifyCode !== 0) {
    err("upgrade applied, but post-upgrade verification is incomplete");
    return 1;
  }
  ok("upgrade complete; doctor and verify exited 0 (read their readiness output above)");
  return 0;
}
