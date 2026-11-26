import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import type { Knowledge, Manifest, Module } from "./manifest";
import { hashFile, readText, sha256, writeText } from "./util";

export const STATE_REL = ".agents/.harness-state.json";

export interface ContextReviewRecord {
  key: string;
  kind: "knowledge" | "module";
  target: string;
  authority: "derived" | "policy" | "review";
  contentHash: string;
  sources: Record<string, string>;
  reason: string;
  session?: string;
  reviewedAt: string;
}

export interface HarnessState {
  // Legacy v0.2 freshness baseline. Kept readable so existing manifests retain
  // advisory drift instead of becoming a breaking migration.
  bindings: Record<string, Record<string, string>>;
  reviews?: Record<string, ContextReviewRecord>;
}

export type ContextFreshnessCode =
  | "source-missing"
  | "authority-changed"
  | "review-missing"
  | "content-changed"
  | "sources-changed"
  | "legacy-baseline-changed"
  | "orphan-review";

export interface ContextFreshnessIssue {
  key: string;
  kind: "knowledge" | "module";
  target: string;
  severity: "blocking" | "advisory";
  code: ContextFreshnessCode;
  reason: string;
  changedSources: string[];
  /** Set by task-scoped callers (deliver): the same blocking issue already existed on the task base. */
  inherited?: boolean;
}

interface ContextSnapshot {
  key: string;
  kind: "knowledge" | "module";
  target: string;
  authority?: "derived" | "policy" | "review";
  contentHash: string;
  sources: Record<string, string>;
  legacyKey: string;
}

function inside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveKnowledgePath(repo: string, knowledge: Knowledge): string {
  const base = knowledge.root === "repo" ? resolve(repo) : resolve(repo, ".agents");
  const target = resolve(base, knowledge.path);
  if (!inside(base, target)) throw new Error(`knowledge path escapes ${knowledge.root === "repo" ? "repository" : ".agents"}: ${knowledge.path}`);
  return target;
}

function hashPath(absPath: string): string {
  if (!existsSync(absPath)) return "(missing)";
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return "(missing)";
  }
  if (stat.isFile()) return hashFile(absPath) ?? "(missing)";
  if (!stat.isDirectory()) return "(missing)";
  const files = fg.sync("**/*", { cwd: absPath, onlyFiles: true, dot: true, followSymbolicLinks: false }).sort();
  const entries = files.map((path) => [path, hashFile(join(absPath, path)) ?? "(missing)"]);
  return sha256(JSON.stringify(entries));
}

function sourceHashes(repo: string, paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const path of paths) result[path] = hashFile(join(repo, path)) ?? "(missing)";
  return result;
}

function knowledgeKey(knowledge: Knowledge): string {
  return `knowledge:${knowledge.root ?? "agents"}:${knowledge.path}`;
}

function moduleContentHash(module: Module): string {
  return sha256(
    JSON.stringify({
      name: module.name,
      role: module.role,
      entry: module.entry,
      upstream: module.upstream ?? [],
      downstream: module.downstream ?? [],
      must_know: module.must_know ?? [],
      pitfalls: module.pitfalls ?? [],
      owns: module.owns ?? [],
      tests: module.tests ?? [],
      checks: module.checks ?? [],
      test_touch: module.test_touch ?? null,
      playbook: module.playbook ?? null,
      remediation: module.remediation ?? null,
    }),
  );
}

function contextSnapshots(repo: string, manifest: Manifest): ContextSnapshot[] {
  const snapshots: ContextSnapshot[] = [];
  for (const knowledge of manifest.knowledge ?? []) {
    if (!knowledge.binds?.length && !knowledge.authority) continue;
    snapshots.push({
      key: knowledgeKey(knowledge),
      kind: "knowledge",
      target: knowledge.path,
      authority: knowledge.authority,
      contentHash: hashPath(resolveKnowledgePath(repo, knowledge)),
      sources: sourceHashes(repo, knowledge.binds ?? []),
      legacyKey: knowledge.path,
    });
  }
  for (const module of manifest.modules ?? []) {
    if (!module.entry?.length) continue;
    const key = `module:${module.name}`;
    snapshots.push({
      key,
      kind: "module",
      target: module.name,
      authority: undefined,
      contentHash: moduleContentHash(module),
      sources: sourceHashes(repo, module.entry),
      legacyKey: key,
    });
  }
  return snapshots;
}

export function computeBindings(repo: string, manifest: Manifest): HarnessState {
  const bindings: HarnessState["bindings"] = {};
  for (const snapshot of contextSnapshots(repo, manifest)) bindings[snapshot.legacyKey] = snapshot.sources;
  return { bindings };
}

export function parseState(raw: string): HarnessState {
  const value = JSON.parse(raw) as Partial<HarnessState>;
  return { bindings: value.bindings ?? {}, reviews: value.reviews ?? {} };
}

export function readState(repo: string): HarnessState | null {
  const raw = readText(join(repo, STATE_REL));
  if (!raw) return null;
  return parseState(raw);
}

export function writeState(repo: string, state: HarnessState): void {
  writeText(join(repo, STATE_REL), JSON.stringify(state, null, 2) + "\n");
}

function changedSources(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

function missingSources(snapshot: ContextSnapshot): string[] {
  return Object.entries(snapshot.sources)
    .filter(([, hash]) => hash === "(missing)")
    .map(([path]) => path)
    .sort();
}

export function inspectContextFreshness(repo: string, manifest: Manifest): ContextFreshnessIssue[] {
  const state = readState(repo);
  const issues: ContextFreshnessIssue[] = [];
  const snapshots = contextSnapshots(repo, manifest);
  const currentKeys = new Set(snapshots.map((snapshot) => snapshot.key));
  const registeredKnowledgeKeys = new Set((manifest.knowledge ?? []).map(knowledgeKey));
  for (const snapshot of snapshots) {
    const review = state?.reviews?.[snapshot.key];
    const missing = missingSources(snapshot);
    if (missing.length) {
      issues.push({
        key: snapshot.key,
        kind: snapshot.kind,
        target: snapshot.target,
        severity: "blocking",
        code: "source-missing",
        reason: "绑定源文件缺失，不能把上下文视为已复核",
        changedSources: missing,
      });
      continue;
    }
    const expectedAuthority = snapshot.authority ?? "review";
    if (review && review.authority !== expectedAuthority) {
      issues.push({
        key: snapshot.key,
        kind: snapshot.kind,
        target: snapshot.target,
        severity: "blocking",
        code: "authority-changed",
        reason: `authority 在复核后从 ${review.authority} 变为 ${expectedAuthority}`,
        changedSources: changedSources(review.sources, snapshot.sources),
      });
      continue;
    }
    if (snapshot.authority) {
      if (!review) {
        issues.push({
          key: snapshot.key,
          kind: snapshot.kind,
          target: snapshot.target,
          severity: "blocking",
          code: "review-missing",
          reason: `尚未记录复核（authority: ${snapshot.authority}）`,
          changedSources: Object.keys(snapshot.sources).sort(),
        });
        continue;
      }
      const sources = changedSources(review.sources, snapshot.sources);
      if (review.contentHash !== snapshot.contentHash) {
        issues.push({
          key: snapshot.key,
          kind: snapshot.kind,
          target: snapshot.target,
          severity: "blocking",
          code: "content-changed",
          reason: "知识内容在复核后发生变化，必须重新记录复核",
          changedSources: sources,
        });
      } else if (sources.length) {
        issues.push({
          key: snapshot.key,
          kind: snapshot.kind,
          target: snapshot.target,
          severity: "blocking",
          code: "sources-changed",
          reason: `绑定源文件在复核后发生变化（authority: ${snapshot.authority}）`,
          changedSources: sources,
        });
      }
      continue;
    }

    // Once a legacy/module context has an explicit review, keep that review
    // durable and blocking. Otherwise preserve the v0.2 advisory baseline.
    if (review) {
      const sources = changedSources(review.sources, snapshot.sources);
      if (review.contentHash !== snapshot.contentHash || sources.length) {
        issues.push({
          key: snapshot.key,
          kind: snapshot.kind,
          target: snapshot.target,
          severity: "blocking",
          code: review.contentHash !== snapshot.contentHash ? "content-changed" : "sources-changed",
          reason: review.contentHash !== snapshot.contentHash ? "上下文内容在复核后发生变化" : "绑定源文件在复核后发生变化",
          changedSources: sources,
        });
      }
      continue;
    }
    const legacy = state?.bindings?.[snapshot.legacyKey];
    if (!legacy) continue;
    const sources = changedSources(legacy, snapshot.sources);
    if (sources.length) {
      issues.push({
        key: snapshot.key,
        kind: snapshot.kind,
        target: snapshot.target,
        severity: "advisory",
        code: "legacy-baseline-changed",
        reason: "legacy freshness baseline changed; record a context review to make it durable",
        changedSources: sources,
      });
    }
  }
  for (const [key, review] of Object.entries(state?.reviews ?? {})) {
    if (currentKeys.has(key)) continue;
    if (review.kind !== "knowledge" || !registeredKnowledgeKeys.has(key)) continue;
    issues.push({
      key,
      kind: review.kind,
      target: review.target,
      severity: "blocking",
      code: "orphan-review",
      reason: "orphan review: 已复核的 knowledge 仍在 manifest 中，但不再声明 binds/authority，已有复核不能静默消失",
      changedSources: Object.keys(review.sources ?? {}).sort(),
    });
  }
  return issues;
}

export interface ContextStateView {
  manifest: Manifest | null;
  state: HarnessState | null;
}

function repoRelative(path: string): string {
  return posix.normalize(path.split(sep).join("/")).replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Repo-relative files/directories whose bytes a context's freshness verdict hashes. */
function contextPaths(manifest: Manifest | null, key: string): string[] {
  const paths: string[] = [];
  for (const knowledge of manifest?.knowledge ?? []) {
    if (knowledgeKey(knowledge) !== key) continue;
    paths.push(repoRelative(knowledge.root === "repo" ? knowledge.path : `.agents/${knowledge.path}`));
    paths.push(...(knowledge.binds ?? []).map(repoRelative));
  }
  for (const module of manifest?.modules ?? []) {
    if (`module:${module.name}` === key) paths.push(...(module.entry ?? []).map(repoRelative));
  }
  return paths;
}

function contextDeclaration(manifest: Manifest | null, key: string): string {
  return JSON.stringify([
    ...(manifest?.knowledge ?? [])
      .filter((knowledge) => knowledgeKey(knowledge) === key)
      .map((knowledge) => ({ binds: knowledge.binds ?? [], authority: knowledge.authority ?? null })),
    ...(manifest?.modules ?? []).filter((module) => `module:${module.name}` === key).map(moduleContentHash),
  ]);
}

function contextReviewEvidence(state: HarnessState | null, issue: ContextFreshnessIssue): string {
  const legacyKey = issue.kind === "knowledge" ? issue.target : issue.key;
  return JSON.stringify([state?.reviews?.[issue.key] ?? null, state?.bindings?.[legacyKey] ?? null]);
}

/**
 * Keys of blocking issues that a task did not introduce. A freshness verdict is
 * a pure function of the manifest declaration, the recorded review, and the
 * bytes of the knowledge target and bound sources. When none of those inputs
 * differs between the task base and the current tree, the same blocking issue
 * already existed on the base. Any doubt keeps the issue task-scoped.
 */
export function inheritedContextKeys(
  issues: readonly ContextFreshnessIssue[],
  current: ContextStateView,
  base: ContextStateView,
  changedFiles: readonly string[],
): Set<string> {
  const inherited = new Set<string>();
  if (!base.manifest) return inherited;
  const changed = changedFiles.map(repoRelative);
  const touches = (path: string) => changed.some((file) => file === path || file.startsWith(`${path}/`));
  for (const issue of issues) {
    if (issue.severity !== "blocking") continue;
    if (contextDeclaration(current.manifest, issue.key) !== contextDeclaration(base.manifest, issue.key)) continue;
    if (contextReviewEvidence(current.state, issue) !== contextReviewEvidence(base.state, issue)) continue;
    const paths = [...contextPaths(current.manifest, issue.key), ...issue.changedSources.map(repoRelative)];
    if (paths.some(touches)) continue;
    inherited.add(issue.key);
  }
  return inherited;
}

export interface RecordContextReviewOpts {
  path?: string;
  module?: string;
  reason: string;
  session?: string;
}

export interface RecordContextReviewsOpts {
  paths?: string[];
  modules?: string[];
  reason: string;
  session?: string;
}

function selectorPath(repo: string, raw: string): string {
  const absolute = resolve(repo, raw);
  const relativePath = inside(resolve(repo), absolute) ? relative(resolve(repo), absolute) : raw;
  return repoRelative(relativePath);
}

/**
 * The knowledge entry a --path names. The manifest spelling is canonical, but
 * the repository-relative spelling an Agent sees on disk (`.agents/knowledge/x.md`,
 * `./x`, a trailing slash, an absolute path inside the target) means the same entry.
 */
function knowledgeForPath(repo: string, manifest: Manifest, raw: string): Knowledge {
  const exact = (manifest.knowledge ?? []).filter((knowledge) => knowledge.path === raw);
  if (exact.length === 1) return exact[0]!;
  const wanted = selectorPath(repo, raw);
  const matches = exact.length
    ? exact
    : (manifest.knowledge ?? []).filter((knowledge) => {
      const declared = repoRelative(knowledge.path);
      const onDisk = repoRelative(knowledge.root === "repo" ? knowledge.path : `.agents/${knowledge.path}`);
      return wanted === onDisk || (knowledge.root !== "repo" && wanted === declared);
    });
  if (matches.length === 1) return matches[0]!;
  if (matches.length) throw new Error(`knowledge path 有歧义: ${raw}`);
  const reviewable = (manifest.knowledge ?? []).filter((knowledge) => knowledge.binds?.length || knowledge.authority);
  throw new Error(
    `manifest 未声明 knowledge path: ${raw}` +
      (reviewable.length
        ? `；可复核的 knowledge.path: ${reviewable.map((knowledge) => knowledge.path).join(", ")}` +
          "（也接受仓库相对写法，如 .agents/<knowledge.path>）"
        : "；manifest 里没有声明 binds/authority 的 knowledge"),
  );
}

function reviewSnapshot(repo: string, manifest: Manifest, snapshots: ContextSnapshot[], selector: { path?: string; module?: string }): ContextSnapshot {
  let snapshot: ContextSnapshot | undefined;
  if (selector.path !== undefined) {
    const knowledge = knowledgeForPath(repo, manifest, selector.path);
    snapshot = snapshots.find((item) => item.key === knowledgeKey(knowledge));
    if (!snapshot) throw new Error(`context 没有 binds/authority，无法记录复核: ${selector.path}`);
  } else {
    snapshot = snapshots.find((item) => item.kind === "module" && item.target === selector.module);
    if (!snapshot) {
      const reviewable = snapshots.filter((item) => item.kind === "module").map((item) => item.target);
      throw new Error(
        `manifest 未声明可复核 module: ${selector.module}` + (reviewable.length ? `；可复核的 module: ${reviewable.join(", ")}` : ""),
      );
    }
  }
  if (snapshot.contentHash === "(missing)") throw new Error(`context target missing: ${snapshot.target}`);
  const missing = missingSources(snapshot);
  if (missing.length) throw new Error(`context source missing: ${missing.join(", ")}`);
  return snapshot;
}

/**
 * Record one Agent review for several contexts in a single state write. Every
 * selector is resolved before anything is written, so one bad name records nothing.
 */
export function recordContextReviews(repo: string, manifest: Manifest, opts: RecordContextReviewsOpts): ContextReviewRecord[] {
  const selectors = [
    ...(opts.paths ?? []).map((path) => ({ path })),
    ...(opts.modules ?? []).map((module) => ({ module })),
  ];
  if (!selectors.length) throw new Error("record-context-review 需要至少一个 --path 或 --module");
  const reason = opts.reason?.trim();
  if (!reason) throw new Error("record-context-review requires a non-empty --reason");

  const snapshots = contextSnapshots(repo, manifest);
  const chosen = new Map<string, ContextSnapshot>();
  for (const selector of selectors) {
    const snapshot = reviewSnapshot(repo, manifest, snapshots, selector);
    chosen.set(snapshot.key, snapshot);
  }
  const reviewedAt = new Date().toISOString();
  const records = [...chosen.values()].map((snapshot): ContextReviewRecord => ({
    key: snapshot.key,
    kind: snapshot.kind,
    target: snapshot.target,
    authority: snapshot.authority ?? "review",
    contentHash: snapshot.contentHash,
    sources: snapshot.sources,
    reason,
    ...(opts.session ? { session: opts.session } : {}),
    reviewedAt,
  }));
  const state = readState(repo) ?? { bindings: {} };
  const reviews = { ...(state.reviews ?? {}) };
  for (const record of records) reviews[record.key] = record;
  writeState(repo, { ...state, reviews });
  return records;
}

export function recordContextReview(repo: string, manifest: Manifest, opts: RecordContextReviewOpts): ContextReviewRecord {
  if (!!opts.path === !!opts.module) throw new Error("只能指定一个 --path 或 --module");
  return recordContextReviews(repo, manifest, {
    ...(opts.path ? { paths: [opts.path] } : { modules: [opts.module!] }),
    reason: opts.reason,
    session: opts.session,
  })[0]!;
}
