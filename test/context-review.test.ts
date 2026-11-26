import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Manifest } from "../src/manifest";
import {
  inheritedContextKeys,
  inspectContextFreshness,
  readState,
  recordContextReview,
  recordContextReviews,
  resolveKnowledgePath,
  type ContextFreshnessIssue,
} from "../src/state";

function write(repo: string, rel: string, content: string): void {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(): { repo: string; manifest: Manifest } {
  const repo = mkdtempSync(join(tmpdir(), "hk-context-"));
  write(repo, "src/api.ts", "export const route = '/v1/user';\n");
  write(repo, "engineering/handbook/api.md", "The route is /v1/user.\n");
  write(repo, ".agents/knowledge/policy.md", "Never log tokens.\n");
  const manifest: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "context-fixture", summary: "context fixture" },
    knowledge: [
      {
        root: "repo",
        path: "engineering/handbook/api.md",
        role: "api",
        authority: "derived",
        binds: ["src/api.ts"],
      },
      {
        root: "agents",
        path: "knowledge/policy.md",
        role: "policy",
        authority: "policy",
        binds: ["src/api.ts"],
      },
    ],
  };
  return { repo, manifest };
}

test("knowledge root resolves arbitrary repository paths without hard-coded folder names", () => {
  const { repo, manifest } = fixture();
  assert.equal(
    resolveKnowledgePath(repo, manifest.knowledge![0]),
    join(repo, "engineering/handbook/api.md"),
  );
  assert.equal(resolveKnowledgePath(repo, manifest.knowledge![1]), join(repo, ".agents/knowledge/policy.md"));
});

test("explicit-authority knowledge is blocking until an Agent records its review", () => {
  const { repo, manifest } = fixture();
  const issues = inspectContextFreshness(repo, manifest);
  assert.equal(issues.length, 2);
  assert.ok(issues.every((issue) => issue.severity === "blocking"));
  assert.ok(issues.every((issue) => /尚未记录复核/.test(issue.reason)));
});

test("record-context-review captures source and knowledge hashes and becomes stale after either changes", () => {
  const { repo, manifest } = fixture();
  const recorded = recordContextReview(repo, manifest, {
    path: "engineering/handbook/api.md",
    reason: "initial code-backed onboarding review",
    session: "agent-session-1",
  });
  assert.equal(recorded.reason, "initial code-backed onboarding review");
  assert.equal(recorded.session, "agent-session-1");
  assert.deepEqual(inspectContextFreshness(repo, manifest).map((issue) => issue.key), ["knowledge:agents:knowledge/policy.md"]);

  write(repo, "src/api.ts", "export const route = '/v2/users';\n");
  const sourceIssue = inspectContextFreshness(repo, manifest).find((issue) => issue.key === "knowledge:repo:engineering/handbook/api.md");
  assert.deepEqual(sourceIssue?.changedSources, ["src/api.ts"]);

  recordContextReview(repo, manifest, {
    path: "engineering/handbook/api.md",
    reason: "route behavior reviewed; documentation updated separately",
  });
  write(repo, "engineering/handbook/api.md", "The route is /v2/users.\n");
  const contentIssue = inspectContextFreshness(repo, manifest).find((issue) => issue.key === "knowledge:repo:engineering/handbook/api.md");
  assert.match(contentIssue?.reason ?? "", /知识内容在复核后发生变化/);
});

test("record-context-review requires one exact target and a non-empty reason", () => {
  const { repo, manifest } = fixture();
  assert.throws(() => recordContextReview(repo, manifest, { path: "engineering/handbook/api.md", reason: "  " }), /reason/);
  assert.throws(() => recordContextReview(repo, manifest, { path: "missing.md", reason: "reviewed" }), /未声明/);
  assert.throws(
    () => recordContextReview(repo, manifest, { path: "engineering/handbook/api.md", module: "core", reason: "reviewed" }),
    /只能指定一个/,
  );
});

test("a review becomes stale when its binds are removed or its authority changes", () => {
  const first = fixture();
  recordContextReview(first.repo, first.manifest, {
    path: "engineering/handbook/api.md",
    reason: "reviewed the original derived source binding",
  });
  first.manifest.knowledge![0]!.binds = [];
  const removedBind = inspectContextFreshness(first.repo, first.manifest).find(
    (issue) => issue.key === "knowledge:repo:engineering/handbook/api.md",
  );
  assert.deepEqual(removedBind?.changedSources, ["src/api.ts"]);

  const second = fixture();
  recordContextReview(second.repo, second.manifest, {
    path: "engineering/handbook/api.md",
    reason: "reviewed as derived documentation",
  });
  second.manifest.knowledge![0]!.authority = "policy";
  const changedAuthority = inspectContextFreshness(second.repo, second.manifest).find(
    (issue) => issue.key === "knowledge:repo:engineering/handbook/api.md",
  );
  assert.match(changedAuthority?.reason ?? "", /authority.*derived.*policy/);
});

test("an implicit-authority review becomes blocking when the registered knowledge loses all binds", () => {
  const current = fixture();
  delete current.manifest.knowledge![0]!.authority;
  recordContextReview(current.repo, current.manifest, {
    path: "engineering/handbook/api.md",
    reason: "reviewed the original implicit source binding",
  });
  current.manifest.knowledge![0]!.binds = [];

  const issue = inspectContextFreshness(current.repo, current.manifest).find(
    (item) => item.key === "knowledge:repo:engineering/handbook/api.md",
  );
  assert.equal(issue?.severity, "blocking", "persisted review must not disappear while the knowledge remains registered");
  assert.match(issue?.reason ?? "", /orphan review/);
  assert.deepEqual(issue?.changedSources, ["src/api.ts"]);

  current.manifest.knowledge = current.manifest.knowledge!.slice(1);
  assert.ok(
    !inspectContextFreshness(current.repo, current.manifest).some(
      (item) => item.key === "knowledge:repo:engineering/handbook/api.md",
    ),
    "removing the knowledge registration is an explicit resolution, not a permanent orphan",
  );
});

test("missing bound sources can neither be recorded nor treated as current", () => {
  const { repo, manifest } = fixture();
  unlinkSync(join(repo, "src/api.ts"));

  assert.throws(
    () =>
      recordContextReview(repo, manifest, {
        path: "engineering/handbook/api.md",
        reason: "cannot truthfully review a missing source",
      }),
    /source missing.*src\/api\.ts/,
  );
  const issue = inspectContextFreshness(repo, manifest).find(
    (item) => item.key === "knowledge:repo:engineering/handbook/api.md",
  );
  assert.match(issue?.reason ?? "", /绑定源文件缺失/);
  assert.deepEqual(issue?.changedSources, ["src/api.ts"]);
});

test("freshness issues carry a stable machine-readable code", () => {
  const { repo, manifest } = fixture();
  assert.deepEqual(inspectContextFreshness(repo, manifest).map((issue) => issue.code), ["review-missing", "review-missing"]);
  recordContextReview(repo, manifest, { path: "engineering/handbook/api.md", reason: "reviewed" });
  recordContextReview(repo, manifest, { path: "knowledge/policy.md", reason: "reviewed" });
  write(repo, "src/api.ts", "export const route = '/v2/users';\n");
  assert.deepEqual(inspectContextFreshness(repo, manifest).map((issue) => issue.code), ["sources-changed", "sources-changed"]);
  write(repo, ".agents/knowledge/policy.md", "Never log tokens or cookies.\n");
  assert.equal(
    inspectContextFreshness(repo, manifest).find((issue) => issue.key === "knowledge:agents:knowledge/policy.md")?.code,
    "content-changed",
  );
  unlinkSync(join(repo, "src/api.ts"));
  assert.ok(inspectContextFreshness(repo, manifest).every((issue) => issue.code === "source-missing"));
});

test("inheritedContextKeys only downgrades blocking issues whose inputs the task left untouched", () => {
  const { repo, manifest } = fixture();
  recordContextReview(repo, manifest, { path: "engineering/handbook/api.md", reason: "reviewed" });
  recordContextReview(repo, manifest, { path: "knowledge/policy.md", reason: "reviewed" });
  const state = readState(repo);
  write(repo, "src/api.ts", "export const route = '/v2/users';\n"); // already stale on the base
  const issues = inspectContextFreshness(repo, manifest);
  const API = "knowledge:repo:engineering/handbook/api.md";
  const POLICY = "knowledge:agents:knowledge/policy.md";
  const same = { manifest, state };
  const keys = (set: Set<string>) => [...set].sort();

  assert.deepEqual(keys(inheritedContextKeys(issues, same, same, ["src/unrelated.ts"])), [POLICY, API]);
  // The task changed a bound source: the staleness is the task's own work.
  assert.deepEqual(keys(inheritedContextKeys(issues, same, same, ["src/api.ts"])), []);
  // The task edited one knowledge document (root=agents resolves under .agents/).
  assert.deepEqual(keys(inheritedContextKeys(issues, same, same, [".agents/knowledge/policy.md"])), [API]);
  assert.deepEqual(keys(inheritedContextKeys(issues, same, same, ["engineering/handbook/api.md"])), [POLICY]);

  // The task changed the manifest declaration of one item.
  const baseManifest: Manifest = structuredClone(manifest);
  baseManifest.knowledge![1].binds = ["src/api.ts", "src/legacy.ts"];
  assert.deepEqual(keys(inheritedContextKeys(issues, same, { manifest: baseManifest, state }, [])), [API]);

  // The task changed one review record; the other record is byte-identical, so it stays inherited.
  const baseState = structuredClone(state)!;
  baseState.reviews![POLICY] = { ...baseState.reviews![POLICY], reason: "older review" };
  assert.deepEqual(keys(inheritedContextKeys(issues, same, { manifest, state: baseState }, [])), [API]);

  // No manifest on the base (the task adopts Harness): nothing can be inherited.
  assert.deepEqual(keys(inheritedContextKeys(issues, same, { manifest: null, state: null }, [])), []);
});

test("inheritedContextKeys treats directory knowledge targets by prefix and ignores advisory issues", () => {
  const manifest: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "dir", summary: "dir" },
    knowledge: [{ path: "knowledge/journal/", authority: "review", binds: ["src/a.ts"] }],
    modules: [{ name: "core", role: "r", entry: ["src/core.ts"] }],
  };
  const journal: ContextFreshnessIssue = {
    key: "knowledge:agents:knowledge/journal/",
    kind: "knowledge",
    target: "knowledge/journal/",
    severity: "blocking",
    code: "sources-changed",
    reason: "stale",
    changedSources: ["src/a.ts"],
  };
  const legacy: ContextFreshnessIssue = {
    key: "module:core",
    kind: "module",
    target: "core",
    severity: "advisory",
    code: "legacy-baseline-changed",
    reason: "legacy",
    changedSources: ["src/core.ts"],
  };
  const view = { manifest, state: null };
  assert.deepEqual([...inheritedContextKeys([journal, legacy], view, view, ["README.md"])], [journal.key]);
  assert.deepEqual([...inheritedContextKeys([journal], view, view, [".agents/knowledge/journal/2026-01-01-adr.md"])], []);
});

test("record-context-review accepts the on-disk path and several contexts in one review", () => {
  const { repo, manifest } = fixture();
  manifest.modules = [{ name: "api", role: "r", entry: ["src/api.ts"] }];
  const records = recordContextReviews(repo, manifest, {
    paths: [".agents/knowledge/policy.md", "./engineering/handbook/api.md"],
    modules: ["api"],
    reason: "re-read src/api.ts against both documents and the module card",
  });
  assert.deepEqual(records.map((record) => record.key).sort(), [
    "knowledge:agents:knowledge/policy.md",
    "knowledge:repo:engineering/handbook/api.md",
    "module:api",
  ]);
  assert.deepEqual(inspectContextFreshness(repo, manifest), []);

  // A wrong name records nothing and says what is reviewable.
  write(repo, "src/api.ts", "export const route = '/v2/user';\n");
  assert.throws(
    () => recordContextReviews(repo, manifest, { paths: ["knowledge/policy.md", "knowledge/nope.md"], reason: "r" }),
    /manifest 未声明 knowledge path: knowledge\/nope\.md；可复核的 knowledge\.path: engineering\/handbook\/api\.md, knowledge\/policy\.md/,
  );
  assert.equal(inspectContextFreshness(repo, manifest).length, 3, "the failed call wrote no review");
  assert.throws(() => recordContextReviews(repo, manifest, { modules: ["nope"], reason: "r" }), /可复核的 module: api/);
});
