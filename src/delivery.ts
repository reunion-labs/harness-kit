import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import {
  collectChanges,
  EMPTY_TREE_BASE,
  gitAdminDir,
  gitRoot,
  listWorktreeFiles,
  readFileAtCommit,
  type ChangeSet,
} from "./git";
import { MANIFEST_REL, type Manifest } from "./manifest";
import {
  inheritedContextKeys,
  parseState,
  readState,
  STATE_REL,
  type ContextFreshnessIssue,
  type HarnessState,
} from "./state";
import { readText, sha256 } from "./util";
import {
  inspectValidationEvidenceFreshness,
  readLatestValidationSession,
  type ValidationEvidence,
  type ValidationSession,
} from "./validation-state";

export type ChangeScopeKind = "explicit-base" | "task" | "worktree";

export interface TaskRecord {
  schema: "ai-harness/task/v1";
  baseSha: string;
  note?: string;
  createdAt: string;
  hostSessionId?: string;
  agent?: string;
}

export interface ChangeScope {
  kind: ChangeScopeKind;
  base: string;
  mode: "exact";
  changes: ChangeSet;
  task: TaskRecord | null;
}

export type StampStatus = "accepted" | "needs-work" | "missing" | "stale" | "no-change";

export interface DeliveryStamp {
  status: StampStatus;
  found: boolean;
  fingerprint?: string;
  planFingerprint?: string;
  runChecksStatus?: string;
  verifyPassed?: boolean;
  scopeBase?: string | null;
  createdAt?: string;
  session?: string;
  stale: boolean;
  valid: boolean;
  reason?: string;
}

function canonicalTarget(repo: string): string {
  try {
    return realpathSync(repo);
  } catch {
    return resolve(repo);
  }
}

function taskStateDir(repo: string): string {
  return join(gitAdminDir(repo), "harness-kit", "task");
}

function taskPath(repo: string): string {
  return join(taskStateDir(repo), `current-${sha256(canonicalTarget(repo)).slice(0, 24)}.json`);
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
}

export function readTaskRecord(repoInput: string): TaskRecord | null {
  const repo = gitRoot(repoInput);
  const raw = readText(taskPath(repo));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as TaskRecord;
    if (value?.schema !== "ai-harness/task/v1" || typeof value.baseSha !== "string" || !value.baseSha) return null;
    return value;
  } catch {
    return null;
  }
}

export function startTaskRecord(args: {
  repo: string;
  baseSha?: string;
  note?: string;
  hostSessionId?: string;
  agent?: string;
}): TaskRecord {
  const repo = gitRoot(args.repo);
  const head = collectChanges(repo, "HEAD", { mode: "exact" }).head;
  const baseSha = args.baseSha ?? head;
  if (!baseSha) throw new Error("cannot start task: repository has no HEAD commit and no --base was provided");
  // Validate base resolves.
  collectChanges(repo, baseSha, { mode: "exact" });
  const record: TaskRecord = {
    schema: "ai-harness/task/v1",
    baseSha,
    createdAt: new Date().toISOString(),
    ...(args.note?.trim() ? { note: args.note.trim() } : {}),
    ...(args.hostSessionId ? { hostSessionId: args.hostSessionId } : {}),
    ...(args.agent ? { agent: args.agent } : {}),
  };
  writePrivateJson(taskPath(repo), record);
  return record;
}

export function clearTaskRecord(repoInput: string): void {
  const repo = gitRoot(repoInput);
  try {
    unlinkSync(taskPath(repo));
  } catch {
    // Missing task record is fine.
  }
}

/**
 * Resolve the change set for delivery:
 * 1. explicit --base
 * 2. worktree task record
 * 3. degrade to worktree vs HEAD (staged + unstaged + untracked)
 */
export function resolveChangeScope(repoInput: string, opts: { base?: string } = {}): ChangeScope {
  const repo = gitRoot(repoInput);
  if (opts.base !== undefined) {
    const changes = collectChanges(repo, opts.base, { mode: "exact" });
    return { kind: "explicit-base", base: opts.base, mode: "exact", changes, task: readTaskRecord(repo) };
  }
  const task = readTaskRecord(repo);
  if (task) {
    const changes = collectChanges(repo, task.baseSha, { mode: "exact" });
    return { kind: "task", base: task.baseSha, mode: "exact", changes, task };
  }
  const changes = collectChanges(repo, "HEAD", { mode: "exact" });
  return { kind: "worktree", base: "HEAD", mode: "exact", changes, task: null };
}

export function stampFromEvidence(repo: string, session: ValidationSession | null): DeliveryStamp {
  if (!session?.lastEvidence) {
    return { status: "missing", found: false, stale: false, valid: false, reason: "no delivery evidence recorded" };
  }
  const evidence = session.lastEvidence;
  const freshness = inspectValidationEvidenceFreshness(repo, evidence);
  const runChecksValid =
    (evidence.runChecksStatus !== undefined ? evidence.runChecksStatus !== "not-verified" : evidence.ok && evidence.status !== "not-verified") &&
    !freshness.stale;
  const verifyPassed = evidence.verifyPassed === true;
  const valid = runChecksValid && verifyPassed && !freshness.error;
  let status: StampStatus;
  if (freshness.stale || freshness.error) status = "stale";
  else if (evidence.status === "no-change" && verifyPassed) status = "no-change";
  else if (valid) status = "accepted";
  else status = "needs-work";
  return {
    status,
    found: true,
    fingerprint: evidence.fingerprint,
    planFingerprint: evidence.planFingerprint,
    runChecksStatus: evidence.runChecksStatus ?? evidence.status,
    verifyPassed: evidence.verifyPassed,
    scopeBase: evidence.resolvedBase ?? evidence.requestedBase,
    createdAt: evidence.createdAt,
    session: session.token,
    stale: freshness.stale || !!freshness.error,
    valid,
    reason: freshness.error || undefined,
  };
}

export function inspectDeliveryStamp(repoInput: string): DeliveryStamp {
  const repo = gitRoot(repoInput);
  try {
    return stampFromEvidence(repo, readLatestValidationSession(repo));
  } catch (error) {
    return {
      status: "missing",
      found: false,
      stale: false,
      valid: false,
      reason: `cannot read delivery stamp: ${(error as Error).message}`,
    };
  }
}

/** True when current scope fingerprint matches an accepted (or clean no-change) stamp. */
export function stampCoversScope(repoInput: string, scope: ChangeScope): boolean {
  const stamp = inspectDeliveryStamp(repoInput);
  if (!stamp.found || stamp.stale || !stamp.valid) return false;
  if (scope.changes.files.length === 0) return stamp.status === "no-change" || stamp.status === "accepted";
  return stamp.status === "accepted" && stamp.fingerprint === scope.changes.fingerprint;
}

/**
 * Keys of blocking context-freshness issues that already existed on the task
 * base (see inheritedContextKeys). The base manifest and review state are read
 * from the resolved base commit; anything unreadable keeps every issue task-scoped.
 */
export function inheritedContextIssueKeys(
  repo: string,
  manifest: Manifest,
  issues: readonly ContextFreshnessIssue[],
  base: string,
): Set<string> {
  if (!issues.some((issue) => issue.severity === "blocking")) return new Set();
  const changes = collectChanges(repo, base, { mode: "exact" });
  if (!changes.resolvedBase) return new Set();
  const manifestText = readFileAtCommit(repo, changes.resolvedBase, MANIFEST_REL);
  if (manifestText === null) return new Set();
  const parsed: unknown = YAML.parse(manifestText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Set();
  const stateText = readFileAtCommit(repo, changes.resolvedBase, STATE_REL);
  const baseState: HarnessState | null = stateText ? parseState(stateText) : null;
  return inheritedContextKeys(
    issues,
    { manifest, state: readState(repo) },
    { manifest: parsed as Manifest, state: baseState },
    changes.files,
  );
}

export interface HarnessTargetLookup {
  /** `.agents/manifest.yaml` exists directly in the requested directory. */
  adopted: boolean;
  /** Nearest ancestor directory inside the same Git worktree that is a Harness target. */
  enclosing: string | null;
  /** Harness targets below the requested directory (absolute paths). */
  nested: string[];
}

/**
 * Where Harness targets are relative to `repo`. Prevents a subdirectory or a
 * monorepo root from being reported as "not adopted" when a target covers it.
 */
export function locateHarnessTargets(repoInput: string): HarnessTargetLookup {
  const repo = resolve(repoInput);
  if (existsSync(join(repo, MANIFEST_REL))) return { adopted: true, enclosing: null, nested: [] };
  let root: string;
  try {
    root = canonicalTarget(gitRoot(repo));
  } catch {
    return { adopted: false, enclosing: null, nested: [] };
  }
  let enclosing: string | null = null;
  for (let dir = canonicalTarget(repo); dir !== root && dirname(dir) !== dir; ) {
    dir = dirname(dir);
    if (existsSync(join(dir, MANIFEST_REL))) {
      enclosing = dir;
      break;
    }
  }
  let nested: string[] = [];
  try {
    const suffix = `/${MANIFEST_REL}`;
    nested = listWorktreeFiles(repo, `**/${MANIFEST_REL}`)
      .filter((path) => path.endsWith(suffix))
      .map((path) => join(repo, path.slice(0, -suffix.length)))
      .sort();
  } catch {
    // Discovery is advisory; the directory itself is still not a Harness target.
  }
  return { adopted: false, enclosing, nested };
}

export function emptyTreeBase(): string {
  return EMPTY_TREE_BASE;
}

export type { ValidationEvidence };
