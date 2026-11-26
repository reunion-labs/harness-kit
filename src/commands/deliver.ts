import { join } from "node:path";
import { collectChanges, isAncestorCommit } from "../git";
import {
  inspectDeliveryStamp,
  locateHarnessTargets,
  resolveChangeScope,
  type ChangeScope,
  type DeliveryStamp,
  type HarnessTargetLookup,
  type TaskRecord,
} from "../delivery";
import { contextFreshnessActions, contextReviewSelector, reviewClearsIssue, type HarnessNextAction } from "../guidance";
import { repoHarnessInvocation } from "../harness-cli";
import type { ContextFreshnessIssue } from "../state";
import { err, info, ok, warn } from "../util";
import { runChecksCmd, type RunChecksReport } from "./run-checks";
import { verifyCmd, type VerifyReport } from "./verify";

export interface DeliverOpts {
  base?: string;
  json?: boolean;
  profile?: string;
}

export type DeliverStatus = "accepted" | "needs-work" | "no-change" | "not-adopted";

/** `not-adopted` exits with its own code so callers stop re-running deliver (needs-work stays 1). */
export const DELIVER_NOT_ADOPTED_EXIT_CODE = 3;

export interface DeliverReport {
  schema: "ai-harness/deliver-report/v1";
  status: DeliverStatus;
  ok: boolean;
  /** false only when no Harness target covers the requested directory (status=not-adopted). */
  adopted: boolean;
  scope: ChangeScope["kind"];
  base: string;
  /** The worktree task record behind scope=task (or kept beside --base), so an old record is visible. */
  task?: TaskRecord | null;
  /** Reasons the task record may belong to an earlier task. */
  taskWarnings?: string[];
  fingerprint: string;
  changed: string[];
  runChecks?: RunChecksReport | null;
  verifyPassed: boolean;
  stamp: DeliveryStamp;
  /** Blocking context-freshness issues that already existed on the task base: reported, never blocking. */
  inheritedContext: ContextFreshnessIssue[];
  /** Present when the requested directory has no manifest of its own. */
  harnessTargets?: { enclosing: string | null; nested: string[] };
  errors: string[];
  next: string[];
  nextActions: HarnessNextAction[];
}

export function captureStdout(fn: () => number): { code: number; output: string } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  let code = 1;
  try {
    code = fn();
  } catch (error) {
    chunks.push(`command threw: ${(error as Error).message}\n`);
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
  }
  return { code, output: chunks.join("") };
}

export function parseRunReport(output: string): RunChecksReport | null {
  try {
    return JSON.parse(output) as RunChecksReport;
  } catch {
    return null;
  }
}

export function parseVerifyReport(output: string): VerifyReport | null {
  try {
    const report = JSON.parse(output) as VerifyReport;
    return report?.schema === "ai-harness/verify-report/v1" ? report : null;
  } catch {
    return null;
  }
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./@:+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function nextActions(status: DeliverStatus, report: RunChecksReport | null, cli: string, context: ContextFreshnessIssue[]): string[] {
  if (status === "accepted" || status === "no-change") return [];
  const next: string[] = [];
  const stale = context.filter((issue) => issue.severity === "blocking" && !issue.inherited);
  const reviewable = stale.filter(reviewClearsIssue);
  if (reviewable.length)
    next.push(
      `re-review stale context, then: ${cli} record-context-review --repo . ${reviewable.map(contextReviewSelector).join(" ")} --reason "<what you re-checked>"`,
    );
  for (const issue of stale.filter((item) => !reviewClearsIssue(item))) next.push(`fix ${issue.key} in .agents/manifest.yaml: ${issue.reason}`);
  if (report) {
    for (const failure of report.failed.slice(0, 5)) {
      next.push(`fix failing check "${failure.id}": ${failure.cmd}`);
    }
    for (const gap of report.gaps.filter((g) => g.severity === "blocking").slice(0, 5)) {
      next.push(gap.suggestion);
    }
    for (const skipped of report.skipped.slice(0, 3)) {
      next.push(`resolve skipped check ${skipped.id}: ${skipped.reason}`);
    }
  }
  next.push(`re-run: ${cli} deliver --repo .`);
  return next;
}

/** One maintenance action per inherited issue, with the exact refresh command. */
function inheritedContextActions(issues: ContextFreshnessIssue[], base: string, cli: string): HarnessNextAction[] {
  return issues.map((issue) => {
    const changed = issue.changedSources.length ? ` (${issue.changedSources.join(", ")})` : "";
    const action: HarnessNextAction = {
      id: `refresh-inherited-context:${issue.key}`,
      priority: "recommended",
      owner: "agent",
      when: "harness-maintenance",
      title: `Refresh inherited context review: ${issue.target}`,
      reason:
        `${issue.reason}${changed}. It was already stale on task base ${base} and this task did not touch its inputs, ` +
        "so it does not block this delivery. Refresh it in a dedicated Harness-maintenance change, not in this task's diff.",
      commands: [],
      completion: "verify reports no context freshness issue for this item.",
    };
    if (issue.code === "source-missing") {
      action.title = `Fix missing bound sources: ${issue.target}`;
      action.reason += ` Update its binds/entry in .agents/manifest.yaml first; a review cannot be recorded against missing sources.`;
      return action;
    }
    if (issue.code === "orphan-review") {
      action.title = `Resolve orphan context review: ${issue.target}`;
      action.reason += ` Restore its binds/authority in .agents/manifest.yaml, or retire the stale review record deliberately.`;
      return action;
    }
    if (issue.changedSources.length) action.commands.push(`git log -n 5 --oneline -- ${issue.changedSources.map(shellArg).join(" ")}`);
    action.commands.push(`${cli} record-context-review --repo . ${contextReviewSelector(issue)} --reason "<what you re-checked>"`);
    return action;
  });
}

function printActions(actions: HarnessNextAction[]): void {
  for (const action of actions) {
    warn(`[${action.priority.toUpperCase()} | ${action.owner.toUpperCase()}] ${action.title}`);
    info(`       why: ${action.reason}`);
    for (const command of action.commands) info(`       run: ${command}`);
    info(`       done when: ${action.completion}`);
  }
}

function reportHuman(report: DeliverReport, cli: string): void {
  if (report.status === "not-adopted" || report.harnessTargets) {
    for (const message of report.errors) err(message);
    if (report.status === "not-adopted")
      warn("deliver: NOT-ADOPTED — no .agents/manifest.yaml covers this directory; harness-kit cannot accept changes here");
    else err("deliver: NEEDS-WORK — run deliver at the Harness target root");
    info("\nNEXT ACTIONS");
    printActions(report.nextActions);
    return;
  }
  info(`deliver (scope=${report.scope}, base ${report.base}) — ${report.changed.length} changed file(s)`);
  if (report.scope === "task" && report.task) {
    const origin = report.task.hostSessionId
      ? `${report.task.agent ?? "agent"} session ${report.task.hostSessionId}`
      : report.task.note
        ? `task-start: ${report.task.note}`
        : "task-start";
    info(`  task record: created ${report.task.createdAt} by ${origin}`);
  }
  for (const message of report.taskWarnings ?? []) warn(message);
  if (report.scope === "worktree" && report.status !== "no-change") {
    info(`  using worktree diff vs HEAD (no task base); for committed task range run: ${cli} task-start`);
  }
  if (report.runChecks) {
    info(`  run-checks: ${report.runChecks.status} (${report.runChecks.passed.length} passed, ${report.runChecks.failed.length} failed)`);
    for (const failure of report.runChecks.failed.slice(0, 5)) {
      err(`${failure.id}: FAILED (exit ${failure.code}) — ${failure.cmd}`);
      for (const line of failure.logTail.split("\n")) if (line) info(`       ${line}`);
    }
    for (const gap of report.runChecks.gaps.filter((g) => g.severity === "blocking").slice(0, 8)) {
      err(`[${gap.kind}] ${gap.where ? `${gap.where} — ` : ""}${gap.why}`);
      info(`       -> ${gap.suggestion}`);
    }
  }
  if (report.verifyPassed) ok("verify: passed");
  else err("verify: failed");
  if (report.inheritedContext.length) {
    warn(
      `context freshness: ${report.inheritedContext.length} issue(s) already stale on task base ${report.base} — ` +
        "not introduced by this task, so they do not block acceptance:",
    );
    for (const issue of report.inheritedContext) {
      const changed = issue.changedSources.length ? ` -> ${issue.changedSources.join(", ")}` : "";
      info(`       ${issue.key}: ${issue.reason}${changed}`);
    }
  }
  for (const message of report.errors) err(message);
  info("");
  if (report.status === "accepted") ok("deliver: ACCEPTED — task stamp is valid for this fingerprint");
  else if (report.status === "no-change") ok("deliver: NO-CHANGE — no pending worktree changes to accept");
  else err(`deliver: NEEDS-WORK — fix failures and re-run ${cli} deliver`);
  if (report.next.length) {
    info("\nNEXT");
    for (const step of report.next) info(`  - ${step}`);
  }
  const maintenance = report.nextActions.filter((action) => action.priority === "recommended");
  if (maintenance.length) {
    info("\nMAINTENANCE (recommended; keep out of this task's diff unless the task is Harness maintenance)");
    printActions(maintenance);
  }
}

function emitReport(report: DeliverReport, json: boolean | undefined, cli: string): number {
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else reportHuman(report, cli);
  if (report.status === "not-adopted") return DELIVER_NOT_ADOPTED_EXIT_CODE;
  return report.ok ? 0 : 1;
}

/** No manifest here: either an enclosing target owns this directory, or nothing does. */
function unadoptedReport(repo: string, opts: DeliverOpts, targets: HarnessTargetLookup): DeliverReport {
  let scope: ChangeScope | null = null;
  try {
    scope = resolveChangeScope(repo, { base: opts.base });
  } catch {
    // A directory without Git is still a valid not-adopted answer.
  }
  const base: Omit<DeliverReport, "status" | "adopted" | "errors" | "next" | "nextActions"> = {
    schema: "ai-harness/deliver-report/v1",
    ok: false,
    scope: scope?.kind ?? "worktree",
    base: scope?.base ?? opts.base ?? "HEAD",
    fingerprint: scope?.changes.fingerprint ?? "",
    changed: scope?.changes.files ?? [],
    runChecks: null,
    verifyPassed: false,
    stamp: { status: "missing", found: false, stale: false, valid: false, reason: "no Harness manifest in this directory" },
    inheritedContext: [],
    harnessTargets: { enclosing: targets.enclosing, nested: targets.nested },
  };

  if (targets.enclosing) {
    const command = `${repoHarnessInvocation(targets.enclosing)} deliver --repo ${shellArg(targets.enclosing)}`;
    return {
      ...base,
      status: "needs-work",
      adopted: true,
      errors: [`${repo} is inside Harness target ${targets.enclosing}; deliver must run at the target root`],
      next: [`re-run at the Harness target root: ${command}`],
      nextActions: [
        {
          id: "deliver-at-harness-target-root",
          priority: "required",
          owner: "agent",
          when: "before-finish",
          title: "Re-run deliver at the Harness target root",
          reason: `The manifest for this directory lives in ${targets.enclosing}.`,
          commands: [command],
          completion: "deliver at the target root reports status=accepted (or no-change on a clean tree).",
        },
      ],
    };
  }

  const touched = targets.nested.filter((dir) => base.changed.some((file) => join(repo, file).startsWith(`${dir}/`)));
  const nestedCommands = touched.map((dir) => `${repoHarnessInvocation(dir)} deliver --repo ${shellArg(dir)}`);
  const nextActions: HarnessNextAction[] = [
    {
      id: "validate-with-repository-conventions",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: "Validate with this repository's own conventions",
      reason:
        "No .agents/manifest.yaml covers this directory, so harness-kit cannot accept the change and re-running deliver will not help.",
      commands: [],
      completion:
        "The checks this repository documents (README / CONTRIBUTING / package scripts / CI config) pass, and the report names which ones ran.",
    },
  ];
  if (nestedCommands.length) {
    nextActions.push({
      id: "deliver-nested-harness-targets",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: "Deliver the changed nested Harness targets",
      reason: `Changed files fall inside nested Harness targets: ${touched.join(", ")}.`,
      commands: nestedCommands,
      completion: "Each listed target reports status=accepted.",
    });
  }
  return {
    ...base,
    status: "not-adopted",
    adopted: false,
    errors: [],
    next: [
      "this directory is not adopted by harness-kit (no .agents/manifest.yaml): validate with the repository's own conventions; do not re-run deliver here",
      ...nestedCommands.map((command) => `changed nested Harness target: ${command}`),
    ],
    nextActions,
  };
}

/**
 * Single task-acceptance entry: resolve change scope → run-checks (unlimited budget)
 * → verify → require stable fingerprint → leave a stamp via validation evidence.
 */
export function deliverCmd(repo: string, opts: DeliverOpts = {}): number {
  const cli = repoHarnessInvocation(repo);
  const targets = locateHarnessTargets(repo);
  if (!targets.adopted) return emitReport(unadoptedReport(repo, opts, targets), opts.json, cli);

  const errors: string[] = [];
  let scope: ChangeScope;
  try {
    scope = resolveChangeScope(repo, { base: opts.base });
  } catch (error) {
    err(`deliver cannot resolve change scope: ${(error as Error).message}`);
    return 1;
  }

  // Unlimited check budget: long E2E for complex tasks is intentional.
  const run = captureStdout(() =>
    runChecksCmd(repo, {
      base: scope.base,
      mode: "exact",
      budgetMs: 0,
      allowEmptyAsNoChange: true,
      profile: opts.profile,
      json: true,
    }),
  );
  const runReport = parseRunReport(run.output);
  if (!runReport) errors.push("run-checks did not return valid JSON evidence");

  // No tight verify budget for deliver (optional env override still respected by verify if set later).
  // contextBase: freshness already stale on the task base is maintenance, not this task's failure.
  const verify = captureStdout(() =>
    verifyCmd(repo, {
      recordManualEvidence: true,
      json: true,
      contextBase: scope.base,
      budgetMs: Number(process.env.HARNESS_KIT_DELIVER_VERIFY_BUDGET_MS) || 60 * 60 * 1000,
    }),
  );
  const verifyPassed = verify.code === 0;
  const verifyReport = parseVerifyReport(verify.output);
  if (!verifyPassed) {
    const failures = verifyReport
      ? verifyReport.messages.filter((message) => message.level === "error").map((message) => message.text).slice(0, 8)
      : verify.output.trim().split("\n").filter(Boolean).slice(-8);
    if (failures.length) errors.push(`verify failed: ${failures.join(" | ")}`);
    else errors.push("verify failed");
  }
  const inheritedContext = (verifyReport?.context ?? []).filter((issue) => issue.inherited);

  let fingerprintError = "";
  if (runReport?.fingerprint) {
    try {
      const current = collectChanges(repo, scope.base, { mode: "exact" });
      if (current.fingerprint !== runReport.fingerprint) {
        fingerprintError = "change fingerprint changed during delivery; re-run deliver on a stable tree";
        errors.push(fingerprintError);
      }
    } catch (error) {
      fingerprintError = `final fingerprint failed: ${(error as Error).message}`;
      errors.push(fingerprintError);
    }
  }

  const runOk = run.code === 0 && !!runReport?.ok;
  const stable = !fingerprintError;
  let status: DeliverStatus;
  if (runOk && verifyPassed && stable && runReport?.status === "no-change") status = "no-change";
  else if (runOk && verifyPassed && stable) status = "accepted";
  else status = "needs-work";

  const actions = [
    ...contextFreshnessActions((verifyReport?.context ?? []).filter((issue) => !issue.inherited), cli),
    ...inheritedContextActions(inheritedContext, scope.base, cli),
  ];
  if (status === "needs-work") {
    actions.unshift({
      id: "fix-delivery-failures",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: "Fix deliver failures and re-run deliver",
      reason: errors.length ? errors.slice(0, 3).join("; ") : "run-checks did not pass for this change.",
      commands: [`${cli} deliver --repo .`],
      completion: "deliver reports status=accepted (or no-change on a clean tree).",
    });
  }

  // Stamp is refreshed by run-checks evidence + verify's markManualVerifyResult.
  const stamp = inspectDeliveryStamp(repo);
  const report: DeliverReport = {
    schema: "ai-harness/deliver-report/v1",
    status,
    ok: status === "accepted" || status === "no-change",
    adopted: true,
    scope: scope.kind,
    base: scope.base,
    fingerprint: runReport?.fingerprint ?? scope.changes.fingerprint,
    changed: runReport?.changed ?? scope.changes.files,
    runChecks: runReport,
    verifyPassed,
    stamp,
    inheritedContext,
    errors,
    next: nextActions(status, runReport, cli, verifyReport?.context ?? []),
    nextActions: actions,
    ...(scope.task ? { task: scope.task } : {}),
    ...(scope.kind === "task" ? { taskWarnings: taskRecordWarnings(repo, scope, cli) } : {}),
  };
  return emitReport(report, opts.json, cli);
}

const TASK_RECORD_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** A task record outlives the session that wrote it; say when it may belong to an earlier task. */
function taskRecordWarnings(repo: string, scope: ChangeScope, cli: string): string[] {
  const task = scope.task;
  if (!task) return [];
  const warnings: string[] = [];
  const restart = `if this is a new task, run ${cli} task-start --repo . first`;
  const age = Date.now() - Date.parse(task.createdAt);
  if (Number.isFinite(age) && age > TASK_RECORD_STALE_MS)
    warnings.push(`task record is ${Math.floor(age / (24 * 60 * 60 * 1000))} day(s) old (base ${task.baseSha}); ${restart}`);
  try {
    if (!isAncestorCommit(repo, task.baseSha, "HEAD"))
      warnings.push(`task base ${task.baseSha} is not an ancestor of HEAD, so the scope includes unrelated history; ${restart}`);
  } catch {
    // Ancestry is advisory; scope resolution already validated the base.
  }
  return warnings;
}
