import { CiConfigError, detectCiBase, NO_BASE_MESSAGE, prepareCiBase, type CiBase, type CiBaseSource, type CiHistory } from "../ci";
import { locateHarnessTargets } from "../delivery";
import type { Gap } from "../planner";
import type { CheckEvidence } from "../validation-state";
import { err, info, ok, warn } from "../util";
import { captureStdout, parseRunReport, parseVerifyReport } from "./deliver";
import { runChecksCmd, type RunChecksReport } from "./run-checks";
import { verifyCmd, type VerifyReport } from "./verify";

/** 0: the change passed; 1: checks or verify failed; 2: configuration / environment error (nothing was judged). */
export const CI_EXIT = { passed: 0, failed: 1, error: 2 } as const;

export interface CiOpts {
  base?: string;
  /** false with --no-fetch: local history only, no fetch and no deepening. */
  fetch?: boolean;
  remote?: string;
  profile?: string;
  json?: boolean;
  /** Test seam; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface CiReport {
  schema: "ai-harness/ci-report/v1";
  status: "passed" | "failed" | "error";
  ok: boolean;
  exitCode: 0 | 1 | 2;
  /** Set when status is error: why the change could not be judged. */
  errorKind: string | null;
  base: {
    source: CiBaseSource | null;
    value: string | null;
    ref: string | null;
    commit: string | null;
    mergeBase: string | null;
    head: string | null;
  };
  history: CiHistory | null;
  changed: string[];
  /** The checks run-checks selected for this change, with their results. */
  checks: CheckEvidence[];
  blockingGaps: Gap[];
  runChecks: RunChecksReport | null;
  verifyPassed: boolean | null;
  verify: VerifyReport | null;
  errors: string[];
}

const VERIFY_BUDGET_MS = 60 * 60 * 1000;

function emptyReport(): CiReport {
  return {
    schema: "ai-harness/ci-report/v1",
    status: "error",
    ok: false,
    exitCode: CI_EXIT.error,
    errorKind: null,
    base: { source: null, value: null, ref: null, commit: null, mergeBase: null, head: null },
    history: null,
    changed: [],
    checks: [],
    blockingGaps: [],
    runChecks: null,
    verifyPassed: null,
    verify: null,
    errors: [],
  };
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 12) : "-";
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function reportHuman(report: CiReport): void {
  const { base, history } = report;
  info(`harness-kit ci — base ${base.value ?? "(none)"}${base.source ? ` from ${base.source}` : ""}`);
  if (base.commit)
    info(`  base: ${base.ref} ${short(base.commit)}; merge-base ${short(base.mergeBase)}; HEAD ${short(base.head)}`);
  if (history) {
    const parts = [history.shallow ? "shallow checkout" : "full history", `fetch ${history.fetch}`];
    if (history.deepened) parts.push(`deepened by ${history.deepened}`);
    if (history.unshallowed) parts.push("unshallowed");
    info(`  history: ${parts.join("; ")}`);
    for (const warning of history.warnings) warn(warning);
  }
  if (report.status === "error") {
    for (const message of report.errors) err(message);
    err(`ci: ERROR — the change was not judged (exit ${CI_EXIT.error})`);
    return;
  }
  const run = report.runChecks;
  info(`  change: ${report.changed.length} file(s); selected checks: ${report.checks.map((check) => check.id).join(", ") || "(none)"}`);
  for (const check of report.checks) {
    const failure = run?.failed.find((item) => item.id === check.id);
    if (check.status === "passed") ok(`${check.id} (${seconds(check.durationMs)})`);
    else if (failure) {
      err(`${check.id}: FAILED (exit ${failure.code}) — ${failure.cmd}`);
      for (const line of failure.logTail.split("\n")) if (line) info(`       ${line}`);
    } else err(`${check.id}: NOT RUN — ${run?.skipped.find((item) => item.id === check.id)?.reason ?? "not run"}`);
  }
  for (const gap of report.blockingGaps) {
    err(`[${gap.kind}] ${gap.where ? `${gap.where} — ` : ""}${gap.why}`);
    info(`       -> ${gap.suggestion}`);
  }
  if (report.blockingGaps.some((gap) => gap.kind === "missing-test-touch" || gap.kind === "module-without-tests" || gap.kind === "unmapped-required-file"))
    info("       waivers recorded by a local run-checks do not apply in CI: add the test, or change the module's policy in the manifest");
  for (const message of run?.errors ?? []) err(message);
  if (report.verifyPassed) ok("verify: passed");
  else {
    const problems = report.verify?.messages.filter((message) => message.level === "error").map((message) => message.text) ?? [];
    err(`verify: FAILED${problems.length ? "" : " (no structured report)"}`);
    for (const problem of problems.slice(0, 12)) info(`       ${problem}`);
  }
  if (report.ok) ok(`ci: PASSED${run?.status === "no-change" ? " (no change against the merge-base)" : ""}`);
  else err(`ci: FAILED — fix the problems above (exit ${CI_EXIT.failed})`);
}

function emit(report: CiReport, json: boolean | undefined): number {
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else reportHuman(report);
  return report.exitCode;
}

function configError(report: CiReport, kind: string, message: string, json: boolean | undefined): number {
  report.errorKind = kind;
  report.errors.push(message);
  return emit(report, json);
}

/**
 * The merge gate for CI: resolve the base from options or the CI environment,
 * make sure the merge-base is in the local history, then run run-checks and
 * verify against that same merge-base. Reads and writes no local delivery
 * state (no stamp, task record, or waivers): its result is the job's exit code.
 */
export function ciCmd(repo: string, opts: CiOpts = {}): number {
  try {
    return ciInternal(repo, opts);
  } catch (error) {
    // A crash judged nothing either: never let it read as "checks failed".
    return configError(emptyReport(), "internal", `unexpected ci failure: ${(error as Error).message}`, opts.json);
  }
}

function ciInternal(repo: string, opts: CiOpts): number {
  const report = emptyReport();
  const environment = opts.env ?? process.env;
  const targets = locateHarnessTargets(repo);
  if (!targets.adopted) {
    const where = targets.enclosing ? `; run ci with --repo ${targets.enclosing}` : "";
    return configError(report, "not-adopted", `no .agents/manifest.yaml in ${repo}${where}`, opts.json);
  }
  const request = detectCiBase(opts.base, environment);
  if (!request) return configError(report, "no-base", NO_BASE_MESSAGE, opts.json);
  report.base.source = request.source;
  report.base.value = request.value;

  let base: CiBase;
  try {
    const prepared = prepareCiBase(repo, request, { fetch: opts.fetch !== false, remote: opts.remote ?? "origin" });
    base = prepared.base;
    report.history = prepared.history;
  } catch (error) {
    if (!(error instanceof CiConfigError)) throw error;
    report.history = error.history;
    report.base = { ...report.base, ...error.resolved };
    return configError(report, error.kind, error.message, opts.json);
  }
  report.base = { ...base };

  const run = captureStdout(() =>
    runChecksCmd(repo, {
      base: base.mergeBase,
      mode: "exact",
      budgetMs: 0,
      allowEmptyAsNoChange: true,
      profile: opts.profile,
      record: false,
      json: true,
    }),
  );
  const runReport = parseRunReport(run.output);
  // Freshness already stale on the merge-base is the target branch's
  // maintenance, not this change's failure: the same rule deliver applies.
  const verify = captureStdout(() =>
    verifyCmd(repo, { recordManualEvidence: false, json: true, contextBase: base.mergeBase, budgetMs: VERIFY_BUDGET_MS }),
  );
  report.runChecks = runReport;
  report.verify = parseVerifyReport(verify.output);
  report.verifyPassed = verify.code === 0;
  if (!runReport) {
    report.errorKind = "run-checks";
    report.errors.push(`run-checks did not return a report: ${run.output.trim().split("\n").slice(-3).join(" ")}`);
    return emit(report, opts.json);
  }
  report.changed = runReport.changed;
  report.checks = runReport.checks;
  report.blockingGaps = runReport.gaps.filter((gap) => gap.severity === "blocking");
  if (runReport.gaps.some((gap) => gap.kind === "diff-unavailable")) {
    report.errorKind = "diff-unavailable";
    report.errors.push(...runReport.errors);
    return emit(report, opts.json);
  }
  report.ok = run.code === 0 && runReport.ok && report.verifyPassed;
  report.status = report.ok ? "passed" : "failed";
  report.exitCode = report.ok ? CI_EXIT.passed : CI_EXIT.failed;
  return emit(report, opts.json);
}
