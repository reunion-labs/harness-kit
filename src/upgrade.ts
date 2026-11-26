import { chmodSync } from "node:fs";
import { join } from "node:path";
import { type Document, parseDocument } from "yaml";
import { assertManagedFileAdoption } from "./adoption";
import { collectChanges } from "./git";
import { harnessInvocation, HARNESS_LOCK_REL } from "./harness-cli";
import { MANIFEST_REL, type Manifest, validateManifest } from "./manifest";
import {
  inspectManagedFiles,
  writeManagedFiles,
  type ManagedFileInspection,
  type ManagedFileTarget,
} from "./managed-files";
import { renderTargets } from "./render";
import { isLinkedGitWorktree } from "./codex-linked-hooks";
import { inspectAgentHookStatus } from "./hook-status";
import {
  pruneRetiredReviews,
  readState as readContextState,
  renderState as renderContextState,
  STATE_REL as CONTEXT_STATE_REL,
} from "./state";
import { hookTargetPaths, installHooksCommand, renderAgentHookTargets, type AgentTool } from "./commands/stop-hooks";

export const UPGRADE_STATE_REL = HARNESS_LOCK_REL;
export const UPGRADE_STATE_SCHEMA = "ai-harness/upgrade-state/v1";
export const UPGRADE_REPORT_SCHEMA = "ai-harness/upgrade-report/v1";

export interface UpgradeState {
  schema: typeof UPGRADE_STATE_SCHEMA;
  package: string;
  version: string;
  manifestSpec: string;
  appliedMigrations: string[];
}

export type UpgradeStatus = "current" | "upgrade-available" | "upgraded" | "incomplete" | "blocked";

export interface UpgradeVerification {
  doctor?: { exitCode: number; output?: string; error?: string };
  verify?: { exitCode: number; report?: unknown; output?: string; error?: string };
}

export const UPGRADE_HOOKS_NOTE =
  "upgrade refreshes the lifecycle hooks Harness already manages in this repository; it never installs new ones or touches user-level dispatchers";

export interface UpgradeReport {
  schema: typeof UPGRADE_REPORT_SCHEMA;
  status: UpgradeStatus;
  package: string;
  fromVersion: string | null;
  toVersion: string;
  manifestSpec: string | null;
  pendingMigrations: string[];
  appliedMigrations: string[];
  changedFiles: string[];
  dirtyFiles: string[];
  /** The managed project hook runner / client configs were (or, with --check, would be) rewritten. */
  hooksChanged: boolean;
  /** Installed lifecycle hooks and what upgrade does about them (absent when none are installed). */
  hooks?: UpgradeHookRefresh;
  errors: string[];
  notes: string[];
  verification?: UpgradeVerification;
}

export interface UpgradeHookRefresh {
  agents: string[];
  /** refreshed: part of this transaction (or would be, under --check); current: nothing to change; manual: needs install-hooks. */
  status: "refreshed" | "current" | "manual";
  /** The exact install-hooks call, when status is manual. */
  command?: string;
  reason?: string;
}

export interface UpgradeOptions {
  packageName: string;
  targetVersion: string;
  check?: boolean;
}

export interface UpgradeMigration {
  id: string;
  migrate(document: Document.Parsed): void;
}

// Ordered, append-only migration registry. Optional product features do not
// belong here: a rule is only for structural changes every managed repository
// must receive when it advances to a newer harness-kit release.
export const UPGRADE_MIGRATIONS: readonly UpgradeMigration[] = [
  {
    id: "upgrade-state-v1",
    migrate: () => {
      // Bootstrap-only migration. The first durable state records that the
      // repository participates in deterministic future migrations.
    },
  },
];

interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(value: string): Semver | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    value,
  );
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return {
    major: core[0],
    minor: core[1],
    patch: core[2],
    prerelease,
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (!left.length || !right.length) return left.length === right.length ? 0 : left.length ? -1 : 1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return a.length === b.length ? (a < b ? -1 : 1) : a.length < b.length ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function compareSemver(left: Semver, right: Semver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function reportBase(options: UpgradeOptions): UpgradeReport {
  return {
    schema: UPGRADE_REPORT_SCHEMA,
    status: "blocked",
    package: options.packageName,
    fromVersion: null,
    toVersion: options.targetVersion,
    manifestSpec: null,
    pendingMigrations: [],
    appliedMigrations: [],
    changedFiles: [],
    dirtyFiles: [],
    hooksChanged: false,
    errors: [],
    notes: [UPGRADE_HOOKS_NOTE],
  };
}

function fail(report: UpgradeReport, message: string): UpgradeReport {
  report.status = "blocked";
  report.errors.push(message);
  return report;
}

function parseState(content: string, options: UpgradeOptions, report: UpgradeReport): UpgradeState | UpgradeReport {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    return fail(report, `${UPGRADE_STATE_REL} is not valid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail(report, `${UPGRADE_STATE_REL} root must be an object`);
  const candidate = value as Partial<UpgradeState>;
  if (candidate.schema !== UPGRADE_STATE_SCHEMA)
    return fail(report, `${UPGRADE_STATE_REL} has unsupported schema: ${String(candidate.schema)}`);
  if (candidate.package !== options.packageName)
    return fail(report, `${UPGRADE_STATE_REL} belongs to ${String(candidate.package)}, not ${options.packageName}`);
  if (typeof candidate.version !== "string" || !parseSemver(candidate.version))
    return fail(report, `${UPGRADE_STATE_REL} has invalid version: ${String(candidate.version)}`);
  if (typeof candidate.manifestSpec !== "string" || !candidate.manifestSpec)
    return fail(report, `${UPGRADE_STATE_REL} has invalid manifestSpec`);
  if (!Array.isArray(candidate.appliedMigrations) || candidate.appliedMigrations.some((id) => typeof id !== "string"))
    return fail(report, `${UPGRADE_STATE_REL} appliedMigrations must be a string array`);
  const unique = new Set(candidate.appliedMigrations);
  if (unique.size !== candidate.appliedMigrations.length)
    return fail(report, `${UPGRADE_STATE_REL} appliedMigrations contains duplicates`);
  const known = new Set(UPGRADE_MIGRATIONS.map((migration) => migration.id));
  const unknown = candidate.appliedMigrations.filter((id) => !known.has(id));
  if (unknown.length) return fail(report, `${UPGRADE_STATE_REL} contains unknown migrations: ${unknown.join(", ")}`);
  return candidate as UpgradeState;
}

function sameInspection(left: ManagedFileInspection, right: ManagedFileInspection): boolean {
  return (
    left.relativePath === right.relativePath &&
    left.absolutePath === right.absolutePath &&
    left.kind === right.kind &&
    left.currentContent === right.currentContent &&
    left.linkTarget === right.linkTarget
  );
}

function renderState(state: UpgradeState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function asManifest(document: Document.Parsed, report: UpgradeReport): Manifest | UpgradeReport {
  if (document.errors.length)
    return fail(report, `${MANIFEST_REL} YAML is invalid: ${document.errors.map((error) => error.message).join("; ")}`);
  const value: unknown = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail(report, `${MANIFEST_REL} root must be an object`);
  const manifest = value as Manifest;
  const errors = validateManifest(manifest).filter((issue) => issue.level === "error");
  if (errors.length) return fail(report, `manifest invalid: ${errors.map((issue) => issue.msg).join("; ")}`);
  return manifest;
}

/**
 * Project hooks Harness already manages are repository files, so they join the
 * same transaction as the generated entries. The linked-worktree Codex
 * dispatcher binds the runner hash in the user directory and Git admin dir, so
 * that case still goes through install-hooks.
 */
function planHookRefresh(repo: string, targetVersion: string): { targets: ManagedFileTarget[]; hooks?: UpgradeHookRefresh } {
  let agents: AgentTool[];
  try {
    agents = inspectAgentHookStatus(repo).configuredAgents;
  } catch {
    return { targets: [] };
  }
  if (!agents.length) return { targets: [] };
  if (agents.includes("codex") && isLinkedGitWorktree(repo))
    return {
      targets: [],
      hooks: {
        agents,
        status: "manual",
        command: installHooksCommand(repo, agents, harnessInvocation(targetVersion)),
        reason: "the linked-worktree Codex dispatcher lives outside the repository",
      },
    };
  const inspections = inspectManagedFiles(repo, hookTargetPaths(agents).map((rel) => [rel, ""] as const));
  const current = new Map(inspections.map((inspection) => [inspection.relativePath, inspection.currentContent]));
  return { targets: renderAgentHookTargets(current, agents, false).map(([path, content]) => [path, content] as const), hooks: { agents, status: "refreshed" } };
}

function internalUpgrade(repo: string, options: UpgradeOptions): UpgradeReport {
  const report = reportBase(options);
  const targetSemver = parseSemver(options.targetVersion);
  if (!targetSemver) return fail(report, `running harness-kit has an invalid version: ${options.targetVersion}`);

  const changes = collectChanges(repo, "HEAD", { mode: "exact" });
  report.dirtyFiles = changes.files;
  if (!options.check && report.dirtyFiles.length)
    return fail(report, `repository has uncommitted changes: ${report.dirtyFiles.join(", ")}`);

  const sourceInspections = inspectManagedFiles(repo, [
    [MANIFEST_REL, ""],
    [UPGRADE_STATE_REL, ""],
  ]);
  const manifestInspection = sourceInspections[0];
  const stateInspection = sourceInspections[1];
  if (manifestInspection.kind === "missing" || manifestInspection.currentContent === null)
    return fail(report, `${MANIFEST_REL} is missing; run harness-kit init first`);

  let state: UpgradeState | null = null;
  if (stateInspection.kind !== "missing") {
    if (stateInspection.currentContent === null) return fail(report, `${UPGRADE_STATE_REL} is not a readable regular file`);
    const parsed = parseState(stateInspection.currentContent, options, report);
    if ("status" in parsed) return parsed;
    state = parsed;
    report.fromVersion = state.version;
    report.appliedMigrations = [...state.appliedMigrations];
    const currentSemver = parseSemver(state.version)!;
    if (compareSemver(currentSemver, targetSemver) > 0)
      return fail(report, `refusing downgrade from ${state.version} to ${options.targetVersion}`);
  }

  const document = parseDocument(manifestInspection.currentContent);
  const sourceManifest = asManifest(document, report);
  if ("status" in sourceManifest) return sourceManifest;
  report.manifestSpec = sourceManifest.spec;
  const normalizedSource = document.toString();

  const applied = new Set(state?.appliedMigrations ?? []);
  const pending = UPGRADE_MIGRATIONS.filter((migration) => !applied.has(migration.id));
  report.pendingMigrations = pending.map((migration) => migration.id);
  for (const migration of pending) migration.migrate(document);

  const finalManifest = asManifest(document, report);
  if ("status" in finalManifest) return finalManifest;
  const migratedManifestContent = document.toString();
  const nextState: UpgradeState = {
    schema: UPGRADE_STATE_SCHEMA,
    package: options.packageName,
    version: options.targetVersion,
    manifestSpec: finalManifest.spec,
    appliedMigrations: UPGRADE_MIGRATIONS.map((migration) => migration.id),
  };
  // Parsing alone must not reformat a repository-owned manifest. Serialize it
  // only when a migration actually changed the document model.
  const manifestChanged = migratedManifestContent !== normalizedSource;
  const finalManifestContent = manifestChanged ? migratedManifestContent : manifestInspection.currentContent;
  // Generated entries pin the lock version, so render them for the version
  // this same transaction writes into the lock.
  // Upgrade refreshes existing entries but never creates the first AGENTS.md:
  // that is the audited end of onboarding (see assertFirstEntryAuthorized).
  const rendered = renderTargets(finalManifest, { harnessVersion: nextState.version });
  const entryMissing = inspectManagedFiles(repo, [["AGENTS.md", ""], ["CLAUDE.md", ""]]).map((inspection) => inspection.kind === "missing");
  const generated = entryMissing[0]
    ? rendered.filter(([path]) => path !== "AGENTS.md" && !(path === "CLAUDE.md" && entryMissing[1]))
    : rendered;
  if (entryMissing[0])
    report.notes.push("AGENTS.md does not exist yet, so upgrade did not create it; onboarding creates the first entry with sync");
  let hookPlan: ReturnType<typeof planHookRefresh>;
  try {
    hookPlan = planHookRefresh(repo, options.targetVersion);
  } catch (error) {
    return fail(report, `cannot refresh lifecycle hooks: ${(error as Error).message}`);
  }
  if (hookPlan.hooks) report.hooks = hookPlan.hooks;
  // Review records of contexts the manifest no longer declares go in the same transaction.
  const contextState = readContextState(repo);
  const pruned = contextState ? pruneRetiredReviews(repo, finalManifest, contextState) : null;
  const targets: ManagedFileTarget[] = [
    // Keep an unchanged manifest in the transaction preflight so generated
    // files can never be committed from bytes that changed after planning.
    [MANIFEST_REL, finalManifestContent],
    ...generated,
    ...hookPlan.targets,
    ...(pruned?.retired.length ? [[CONTEXT_STATE_REL, renderContextState(pruned.state)] as ManagedFileTarget] : []),
    [UPGRADE_STATE_REL, renderState(nextState)],
  ];
  const hookPaths = new Set(hookPlan.targets.map(([path]) => path));
  const preflight = inspectManagedFiles(repo, targets);
  const generatedPaths = new Set(generated.map(([path]) => path));
  try {
    assertManagedFileAdoption(
      repo,
      preflight.filter((inspection) => generatedPaths.has(inspection.relativePath)),
      false,
    );
  } catch (error) {
    return fail(report, (error as Error).message);
  }
  report.changedFiles = preflight
    .filter((inspection) => !inspection.satisfiesDesired)
    .map((inspection) => inspection.relativePath);
  report.hooksChanged = report.changedFiles.some((path) => hookPaths.has(path));
  if (report.hooks?.status === "refreshed" && !report.hooksChanged) report.hooks.status = "current";
  const stateMatchesManifest = state?.manifestSpec === finalManifest.spec;
  const stateMatchesVersion = state?.version === options.targetVersion;
  const stateMatchesMigrations = state?.appliedMigrations.join("\0") === nextState.appliedMigrations.join("\0");
  // Dropping retired review records rides along with a real upgrade; on its
  // own it is sync's job and never makes --check report "upgrade available".
  const needsUpgrade =
    report.changedFiles.some((path) => path !== CONTEXT_STATE_REL) || !stateMatchesManifest || !stateMatchesVersion || !stateMatchesMigrations;
  if (!needsUpgrade) report.changedFiles = report.changedFiles.filter((path) => path !== CONTEXT_STATE_REL);
  const retiredNote = (verb: string) => `${verb} retired context review record(s) in ${CONTEXT_STATE_REL}: ${pruned!.retired.join(", ")}`;
  if (options.check && needsUpgrade && pruned?.retired.length) report.notes.push(retiredNote("will drop"));

  if (options.check) {
    report.status = needsUpgrade ? "upgrade-available" : "current";
    return report;
  }
  if (!needsUpgrade) {
    report.status = "current";
    report.pendingMigrations = [];
    return report;
  }

  const expected = new Map(preflight.map((inspection) => [inspection.relativePath, inspection]));
  const result = writeManagedFiles(repo, targets, {
    authorize: (inspections) => {
      for (const inspection of inspections) {
        const prior = expected.get(inspection.relativePath);
        if (!prior || !sameInspection(prior, inspection))
          throw new Error(`upgrade target changed after inspection: ${inspection.relativePath}`);
      }
      assertManagedFileAdoption(
        repo,
        inspections.filter((inspection) => generatedPaths.has(inspection.relativePath)),
        false,
      );
    },
  });
  // A runner written fresh (configs present, runner missing) must be executable.
  if (result.written.includes(".agents/hooks/harness-agent-hook.sh")) chmodSync(join(repo, ".agents/hooks/harness-agent-hook.sh"), 0o755);
  report.status = "upgraded";
  report.changedFiles = result.written;
  if (result.written.includes(CONTEXT_STATE_REL)) report.notes.push(retiredNote("dropped"));
  report.appliedMigrations = nextState.appliedMigrations;
  return report;
}

/**
 * Upgrade a repository to the version of the running CLI. The core never
 * prints and never reaches a package registry, CI service, or code host.
 */
export function upgradeRepository(repo: string, options: UpgradeOptions): UpgradeReport {
  try {
    return internalUpgrade(repo, options);
  } catch (error) {
    return fail(reportBase(options), (error as Error).message);
  }
}

export function initialUpgradeState(packageName: string, version: string, manifestSpec: string): string {
  return renderState({
    schema: UPGRADE_STATE_SCHEMA,
    package: packageName,
    version,
    manifestSpec,
    appliedMigrations: UPGRADE_MIGRATIONS.map((migration) => migration.id),
  });
}
