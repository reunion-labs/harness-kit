import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChangeScope, startTaskRecord, readTaskRecord } from "../src/delivery";
import { DELIVER_NOT_ADOPTED_EXIT_CODE, deliverCmd } from "../src/commands/deliver";
import { syncCmd } from "../src/commands/sync";
import { verifyCmd } from "../src/commands/verify";
import { loadManifest } from "../src/manifest";
import { recordContextReview } from "../src/state";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

function write(repo: string, rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commit(repo: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", message],
    { cwd: repo },
  );
}

function fixture(extraManifest = "", setup: (repo: string) => void = () => {}): string {
  const repo = mkdtempSync(join(tmpdir(), "hk-delivery-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity:
  name: delivery-fixture
  summary: delivery scope fixture
capabilities:
  test:
    run: 'node -e "if (process.env.HK_TEST_FAIL) process.exit(1)"'
modules:
  - name: core
    role: fixture
    entry: [src/core.ts]
    owns: [src/**]
    tests: [test/**]
    checks: [test]
    test_touch: required
${extraManifest}`,
  );
  write(repo, "src/core.ts", "export const value = 1;\n");
  write(repo, "test/core.test.ts", "// coverage\n");
  setup(repo);
  syncCmd(repo);
  commit(repo, "initial");
  return repo;
}

const LOCK = (version: string) =>
  JSON.stringify({
    schema: "ai-harness/upgrade-state/v1",
    package: "@erzhe/harness-kit",
    version,
    manifestSpec: "ai-harness/v0",
    appliedMigrations: ["upgrade-state-v1"],
  }) + "\n";

const POLICY_KEY = "knowledge:agents:knowledge/policy.md";
const CORE_KEY = "knowledge:agents:knowledge/core.md";

/**
 * Both knowledge items are reviewed, then mainline bumps package.json without a
 * review: knowledge/policy.md is already stale on the base every task starts from.
 */
function staleBaseFixture(): string {
  const repo = fixture(
    `knowledge:
  - path: knowledge/policy.md
    authority: policy
    binds: [package.json]
  - path: knowledge/core.md
    authority: derived
    binds: [src/core.ts]
`,
    (dir) => {
      write(dir, ".agents/harness.lock.json", LOCK("1.2.3"));
      write(dir, "package.json", '{ "name": "fixture", "version": "1.0.0" }\n');
      write(dir, ".agents/knowledge/policy.md", "# Policy\n");
      write(dir, ".agents/knowledge/core.md", "# Core\n");
    },
  );
  const manifest = loadManifest(repo);
  recordContextReview(repo, manifest, { path: "knowledge/policy.md", reason: "fixture review" });
  recordContextReview(repo, manifest, { path: "knowledge/core.md", reason: "fixture review" });
  commit(repo, "record reviews");
  write(repo, "package.json", '{ "name": "fixture", "version": "1.0.1" }\n');
  commit(repo, "bump dependency without review");
  return repo;
}

function captureJson(fn: () => number): { code: number; json: any } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => {
    chunks.push(String(s));
    return true;
  };
  let code: number;
  try {
    code = fn();
  } finally {
    (process.stdout as any).write = orig;
  }
  return { code, json: JSON.parse(chunks.join("")) };
}

test("resolveChangeScope: worktree dirty falls back to HEAD exact diff", () => {
  const repo = fixture();
  write(repo, "src/core.ts", "export const value = 2;\n");
  const scope = resolveChangeScope(repo);
  assert.equal(scope.kind, "worktree");
  assert.equal(scope.base, "HEAD");
  assert.ok(scope.changes.files.includes("src/core.ts"));
});

test("resolveChangeScope: task base covers later commits", () => {
  const repo = fixture();
  const started = startTaskRecord({ repo, note: "feature" });
  assert.equal(readTaskRecord(repo)?.baseSha, started.baseSha);
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  commit(repo, "task commit");
  const scope = resolveChangeScope(repo);
  assert.equal(scope.kind, "task");
  assert.deepEqual(scope.changes.files.sort(), ["src/core.ts", "test/core.test.ts"]);
});

test("resolveChangeScope: clean worktree is empty without task", () => {
  const repo = fixture();
  const scope = resolveChangeScope(repo);
  assert.equal(scope.kind, "worktree");
  assert.equal(scope.changes.files.length, 0);
});

test("deliver accepts worktree changes and stamps evidence", () => {
  const repo = fixture();
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  const { code, json } = captureJson(() => deliverCmd(repo, { json: true }));
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "accepted");
  assert.equal(json.scope, "worktree");
  assert.equal(json.ok, true);
  assert.equal(json.verifyPassed, true);
});

test("deliver reports needs-work when checks fail", () => {
  const repo = fixture();
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  const prev = process.env.HK_TEST_FAIL;
  process.env.HK_TEST_FAIL = "1";
  try {
    const { code, json } = captureJson(() => deliverCmd(repo, { json: true }));
    assert.equal(code, 1);
    assert.equal(json.status, "needs-work");
    assert.ok(json.next.some((step: string) => /deliver/.test(step)));
  } finally {
    if (prev === undefined) delete process.env.HK_TEST_FAIL;
    else process.env.HK_TEST_FAIL = prev;
  }
});

test("deliver no-change on clean tree", () => {
  const repo = fixture();
  const { code, json } = captureJson(() => deliverCmd(repo, { json: true }));
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "no-change");
});

test("deliver accepts a task whose base already had stale context and lists it as maintenance", () => {
  const repo = staleBaseFixture();
  startTaskRecord({ repo, note: "unrelated feature" });
  write(repo, "src/other.ts", "export const other = 1;\n");
  write(repo, "test/other.test.ts", "// covers other\n");
  commit(repo, "feature");

  const { code, json } = captureJson(() => deliverCmd(repo, { json: true }));
  assert.equal(code, 0, JSON.stringify(json, null, 2));
  assert.equal(json.status, "accepted");
  assert.equal(json.scope, "task");
  assert.equal(json.adopted, true);
  assert.equal(json.verifyPassed, true);
  assert.equal(json.stamp.status, "accepted");
  assert.deepEqual(json.next, []);
  assert.deepEqual(json.inheritedContext.map((issue: any) => [issue.key, issue.inherited, issue.code]), [
    [POLICY_KEY, true, "sources-changed"],
  ]);
  assert.deepEqual(json.inheritedContext[0].changedSources, ["package.json"]);
  const refresh = json.nextActions.find((action: any) => action.id === `refresh-inherited-context:${POLICY_KEY}`);
  assert.equal(refresh.priority, "recommended");
  assert.equal(refresh.when, "harness-maintenance");
  assert.deepEqual(refresh.commands, [
    "git log -n 5 --oneline -- package.json",
    'npx -y @erzhe/harness-kit@1.2.3 record-context-review --repo . --path knowledge/policy.md --reason "<what you re-checked>"',
  ]);
  assert.equal(json.nextActions.filter((action: any) => action.priority === "required").length, 0);

  // Plain verify stays the strict CI gate: the inherited staleness still fails there.
  const strict = captureJson(() => verifyCmd(repo, { json: true, recordManualEvidence: false }));
  assert.equal(strict.code, 1);
  assert.ok(strict.json.context.some((issue: any) => issue.key === POLICY_KEY && !issue.inherited));
});

test("deliver keeps staleness the task introduced blocking while still separating the inherited part", () => {
  const repo = staleBaseFixture();
  startTaskRecord({ repo });
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");

  const { code, json } = captureJson(() => deliverCmd(repo, { json: true }));
  assert.equal(code, 1, JSON.stringify(json, null, 2));
  assert.equal(json.status, "needs-work");
  assert.equal(json.verifyPassed, false);
  assert.ok(json.errors.some((message: string) => message.includes(CORE_KEY)), json.errors.join("\n"));
  assert.deepEqual(json.inheritedContext.map((issue: any) => issue.key), [POLICY_KEY]);
  assert.equal(json.nextActions[0].id, "fix-delivery-failures");
  assert.deepEqual(json.nextActions[0].commands, ["npx -y @erzhe/harness-kit@1.2.3 deliver --repo ."]);
  assert.ok(json.next.includes("re-run: npx -y @erzhe/harness-kit@1.2.3 deliver --repo ."));

  // Touching the stale bound source makes that staleness the task's own work too.
  write(repo, "package.json", '{ "name": "fixture", "version": "1.0.2" }\n');
  const touched = captureJson(() => deliverCmd(repo, { json: true }));
  assert.equal(touched.json.status, "needs-work");
  assert.deepEqual(touched.json.inheritedContext, []);
  assert.ok(touched.json.errors.some((message: string) => message.includes(POLICY_KEY)));
});

test("recording the task's own review keeps other inherited staleness non-blocking (worktree scope)", () => {
  const repo = staleBaseFixture();
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  recordContextReview(repo, loadManifest(repo), { path: "knowledge/core.md", reason: "core still describes value" });

  const { code, json } = captureJson(() => deliverCmd(repo, { json: true }));
  assert.equal(code, 0, JSON.stringify(json, null, 2));
  assert.equal(json.status, "accepted");
  assert.equal(json.scope, "worktree");
  assert.deepEqual(json.inheritedContext.map((issue: any) => issue.key), [POLICY_KEY]);
});

test("deliver in a repository without a manifest is not-adopted, not needs-work", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-delivery-plain-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  write(repo, "src/app.ts", "export const app = 1;\n");
  commit(repo, "initial");
  write(repo, "src/app.ts", "export const app = 2;\n");

  const { code, json } = captureJson(() => deliverCmd(repo, { json: true }));
  assert.equal(code, DELIVER_NOT_ADOPTED_EXIT_CODE);
  assert.equal(code, 3);
  assert.equal(json.status, "not-adopted");
  assert.equal(json.ok, false);
  assert.equal(json.adopted, false);
  assert.deepEqual(json.changed, ["src/app.ts"]);
  assert.deepEqual(json.harnessTargets, { enclosing: null, nested: [] });
  assert.equal(json.stamp.found, false);
  assert.match(json.next[0], /not adopted by harness-kit.*own conventions.*do not re-run deliver/);
  assert.ok(json.next.every((step: string) => !/^re-run/.test(step)));
  assert.deepEqual(json.nextActions.map((action: any) => action.id), ["validate-with-repository-conventions"]);
  // Nothing is recorded for a repository Harness does not manage.
  assert.equal(existsSync(join(repo, ".git", "harness-kit", "validation")), false);

  const outsideGit = mkdtempSync(join(tmpdir(), "hk-delivery-nogit-"));
  const bare = captureJson(() => deliverCmd(outsideGit, { json: true }));
  assert.equal(bare.code, 3);
  assert.equal(bare.json.status, "not-adopted");
});

test("the real CLI exits 3 with a single not-adopted document", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-delivery-cli-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const result = spawnSync(TSX, [CLI, "deliver", "--repo", repo, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).status, "not-adopted");

  const text = spawnSync(TSX, [CLI, "deliver", "--repo", repo], { encoding: "utf8" });
  assert.equal(text.status, 3);
  assert.match(text.stdout, /deliver: NOT-ADOPTED/);
  assert.match(text.stdout, /Validate with this repository's own conventions/);
  assert.doesNotMatch(text.stdout, /NEEDS-WORK|re-run:/);
});

test("a subdirectory of a Harness target is redirected to the target root, never reported as not-adopted", () => {
  const repo = fixture();
  mkdirSync(join(repo, "src", "nested"), { recursive: true });
  const { code, json } = captureJson(() => deliverCmd(join(repo, "src", "nested"), { json: true }));
  assert.equal(code, 1);
  assert.equal(json.status, "needs-work");
  assert.equal(json.adopted, true);
  assert.equal(json.harnessTargets.enclosing, realpathSync(repo));
  assert.equal(json.nextActions[0].id, "deliver-at-harness-target-root");
  assert.match(json.nextActions[0].commands[0], new RegExp(`deliver --repo ${realpathSync(repo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

test("a monorepo root without a manifest points changed files at their nested Harness target", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-delivery-mono-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  write(repo, "packages/app/.agents/manifest.yaml", "spec: ai-harness/v0\nidentity: { name: app, summary: app }\n");
  write(repo, "packages/app/src/app.ts", "export const app = 1;\n");
  write(repo, "packages/lib/src/lib.ts", "export const lib = 1;\n");
  commit(repo, "initial");

  write(repo, "packages/lib/src/lib.ts", "export const lib = 2;\n");
  const untouched = captureJson(() => deliverCmd(repo, { json: true }));
  assert.equal(untouched.code, 3);
  assert.deepEqual(untouched.json.harnessTargets.nested, [join(repo, "packages/app")]);
  assert.deepEqual(untouched.json.nextActions.map((action: any) => action.id), ["validate-with-repository-conventions"]);

  write(repo, "packages/app/src/app.ts", "export const app = 2;\n");
  const touched = captureJson(() => deliverCmd(repo, { json: true }));
  assert.equal(touched.code, 3);
  assert.equal(touched.json.status, "not-adopted");
  const nested = touched.json.nextActions.find((action: any) => action.id === "deliver-nested-harness-targets");
  assert.deepEqual(nested.commands, [`npx -y @erzhe/harness-kit@latest deliver --repo ${join(repo, "packages/app")}`]);
});
