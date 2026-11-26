import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCiBase } from "../src/ci";
import { syncCmd } from "../src/commands/sync";
import { gitAdminDir } from "../src/git";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);

const MANIFEST = `spec: ai-harness/v0
identity:
  name: ci-fixture
  summary: ci gate fixture
capabilities:
  test:
    run: "node checks/test.mjs"
modules:
  - name: core
    role: fixture code
    entry: [src/core.ts]
    owns: [src/**]
    tests: [test/**]
    checks: [test]
    test_touch: required
invariants:
  - id: no-todo-in-src
    rule: no TODO markers in src
    enforcement:
      forbid_pattern: ["TODO"]
      path_glob: ["src/**"]
`;

// The fixture's test capability fails when src/core.ts says "broken".
const CHECK = `import { readFileSync } from "node:fs";
process.exit(readFileSync("src/core.ts", "utf8").includes("broken") ? 1 : 0);
`;

function write(repo: string, rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** origin: main with history, plus a feature branch three commits ahead of a main that moved on. */
function origin(): { dir: string; forkPoint: string } {
  const dir = mkdtempSync(join(tmpdir(), "hk-ci-origin-"));
  git(dir, ["init", "-q", "-b", "main"]);
  write(dir, ".agents/manifest.yaml", MANIFEST);
  write(dir, "checks/test.mjs", CHECK);
  write(dir, "src/core.ts", "export const value = 1;\n");
  write(dir, "test/core.test.ts", "// covers 1\n");
  syncCmd(dir, { createEntry: true });
  commit(dir, "initial");
  for (let index = 0; index < 5; index++) {
    write(dir, `docs/note-${index}.md`, `note ${index}\n`);
    commit(dir, `main history ${index}`);
  }
  const forkPoint = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  for (let index = 2; index <= 4; index++) {
    write(dir, "src/core.ts", `export const value = ${index};\n`);
    write(dir, "test/core.test.ts", `// covers ${index}\n`);
    commit(dir, `feature ${index}`);
  }
  git(dir, ["checkout", "-q", "main"]);
  write(dir, "docs/after-fork.md", "main moved on\n");
  commit(dir, "main after fork");
  return { dir, forkPoint };
}

/** A CI-like checkout of the feature branch: full, or shallow (depth 1, single branch). */
function checkout(source: string, shallow: boolean): string {
  const dir = join(mkdtempSync(join(tmpdir(), "hk-ci-clone-")), "repo");
  const args = shallow
    ? ["clone", "-q", "--depth", "1", "--single-branch", "--branch", "feature", `file://${source}`, dir]
    : ["clone", "-q", "--branch", "feature", source, dir];
  execFileSync("git", args, { stdio: "ignore" });
  return dir;
}

/** The test runner's own CI variables must never leak into these runs. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!/^(GITHUB_|GITLAB_|CI_|HARNESS_KIT_BASE$)/.test(key)) env[key] = value;
  return { ...env, ...extra };
}

function ci(repo: string, args: string[] = [], extra: Record<string, string> = {}): { code: number; body: any; stdout: string } {
  const result = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--json", ...args], { cwd: repo, encoding: "utf8", env: cleanEnv(extra) });
  let body: any = null;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    body = null;
  }
  return { code: result.status ?? -1, body, stdout: result.stdout + result.stderr };
}

function localStateFiles(repo: string): string[] {
  const dir = join(gitAdminDir(repo), "harness-kit");
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
}

test("the base comes from --base first, then HARNESS_KIT_BASE, then the CI platform", () => {
  const gitlab = { GITLAB_CI: "true", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main", CI_MERGE_REQUEST_DIFF_BASE_SHA: SHA_A };
  assert.deepEqual(detectCiBase("release", { ...gitlab, HARNESS_KIT_BASE: "develop", GITHUB_BASE_REF: "main" }), { source: "option", value: "release" });
  assert.deepEqual(detectCiBase(undefined, { ...gitlab, HARNESS_KIT_BASE: "develop" }), { source: "HARNESS_KIT_BASE", value: "develop" });
  assert.deepEqual(detectCiBase("  ", { HARNESS_KIT_BASE: " develop " }), { source: "HARNESS_KIT_BASE", value: "develop" });
  // GitLab: the MR diff base, except in merged-result / merge-train pipelines whose HEAD sits on the target tip.
  assert.deepEqual(detectCiBase(undefined, gitlab), { source: "CI_MERGE_REQUEST_DIFF_BASE_SHA", value: SHA_A });
  assert.deepEqual(detectCiBase(undefined, { ...gitlab, CI_MERGE_REQUEST_EVENT_TYPE: "merged_result" }), {
    source: "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
    value: "main",
  });
  assert.deepEqual(detectCiBase(undefined, { GITLAB_CI: "true", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" }), {
    source: "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
    value: "main",
  });
  assert.deepEqual(detectCiBase(undefined, { GITLAB_CI: "true", CI_MERGE_REQUEST_DIFF_BASE_SHA: SHA_B }), {
    source: "CI_MERGE_REQUEST_DIFF_BASE_SHA",
    value: SHA_B,
  });
  // GitHub pull_request / pull_request_target.
  assert.deepEqual(detectCiBase(undefined, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" }), {
    source: "GITHUB_BASE_REF",
    value: "main",
  });
});

test("push and merge-queue pipelines judge the pushed range; a new branch has none", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-ci-event-"));
  const event = (name: string, payload: unknown) => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(payload));
    return { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: path, GITHUB_BASE_REF: "" };
  };
  assert.deepEqual(detectCiBase(undefined, event("push", { before: SHA_A, after: SHA_B })), { source: "GITHUB_EVENT_PATH:before", value: SHA_A });
  assert.equal(detectCiBase(undefined, event("push", { before: ZERO, after: SHA_B })), null, "branch creation has no before");
  assert.deepEqual(detectCiBase(undefined, event("merge_group", { merge_group: { base_sha: SHA_B } })), {
    source: "GITHUB_EVENT_PATH:merge_group.base_sha",
    value: SHA_B,
  });
  assert.equal(detectCiBase(undefined, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: join(dir, "missing.json") }), null);
  assert.deepEqual(detectCiBase(undefined, { GITLAB_CI: "true", CI_PIPELINE_SOURCE: "push", CI_COMMIT_BEFORE_SHA: SHA_A }), {
    source: "CI_COMMIT_BEFORE_SHA",
    value: SHA_A,
  });
  assert.equal(detectCiBase(undefined, { GITLAB_CI: "true", CI_COMMIT_BEFORE_SHA: ZERO }), null);
  assert.equal(detectCiBase(undefined, { CI_COMMIT_BEFORE_SHA: SHA_A }), null, "only inside GitLab CI");
  assert.equal(detectCiBase(undefined, {}), null);
});

test("ci passes a good change against the merge-base and leaves no local delivery state", () => {
  const { dir, forkPoint } = origin();
  const repo = checkout(dir, false);
  const before = localStateFiles(repo);
  const { code, body, stdout } = ci(repo, ["--base", "main"]);
  assert.equal(code, 0, stdout);
  assert.equal(body.schema, "ai-harness/ci-report/v1");
  assert.deepEqual({ status: body.status, ok: body.ok, exitCode: body.exitCode }, { status: "passed", ok: true, exitCode: 0 });
  assert.equal(body.base.source, "option");
  assert.equal(body.base.ref, "refs/remotes/origin/main");
  // main moved on after the fork; the change is judged from the fork point, not main's tip.
  assert.equal(body.base.mergeBase, forkPoint);
  assert.notEqual(body.base.commit, forkPoint);
  assert.equal(body.history.fetch, "fetched");
  assert.deepEqual(body.changed, ["src/core.ts", "test/core.test.ts"]);
  assert.deepEqual(body.checks.map((check: any) => [check.id, check.status]), [["test", "passed"]]);
  assert.equal(body.verifyPassed, true);
  assert.equal(body.verify.schema, "ai-harness/verify-report/v1");
  assert.deepEqual(localStateFiles(repo), before, "no stamp, task record, waiver, or evidence written");
  const evidence = spawnSync(TSX, [CLI, "evidence", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8", env: cleanEnv() });
  assert.equal(JSON.parse(evidence.stdout).found, false);

  const text = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--base", "main"], { cwd: repo, encoding: "utf8", env: cleanEnv() });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /harness-kit ci — base main from option/);
  assert.match(text.stdout, /merge-base [0-9a-f]{12}/);
  assert.match(text.stdout, /OK {3}test \(/);
  assert.match(text.stdout, /OK {3}ci: PASSED/);
});

test("each CI variable source drives the same gate", () => {
  const { dir, forkPoint } = origin();
  const repo = checkout(dir, false);
  const cases: Array<[Record<string, string>, string]> = [
    [{ HARNESS_KIT_BASE: "main" }, "HARNESS_KIT_BASE"],
    [{ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" }, "GITHUB_BASE_REF"],
    [{ GITLAB_CI: "true", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main", CI_MERGE_REQUEST_EVENT_TYPE: "merged_result" }, "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"],
    [{ GITLAB_CI: "true", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main", CI_MERGE_REQUEST_DIFF_BASE_SHA: forkPoint }, "CI_MERGE_REQUEST_DIFF_BASE_SHA"],
  ];
  for (const [env, source] of cases) {
    const { code, body, stdout } = ci(repo, [], env);
    assert.equal(code, 0, `${source}: ${stdout}`);
    assert.equal(body.base.source, source);
    assert.equal(body.base.mergeBase, forkPoint, source);
  }
  // The option still wins over every variable.
  const { body } = ci(repo, ["--base", forkPoint], { HARNESS_KIT_BASE: "does-not-exist", GITHUB_BASE_REF: "nope" });
  assert.equal(body.base.source, "option");
  assert.equal(body.history.fetch, "present");
});

test("no base is a configuration error, never a guess", () => {
  const { dir } = origin();
  const repo = checkout(dir, false);
  const { code, body } = ci(repo);
  assert.equal(code, 2);
  assert.deepEqual({ status: body.status, errorKind: body.errorKind }, { status: "error", errorKind: "no-base" });
  assert.match(body.errors[0], /never guesses a base such as HEAD~1/);
  assert.equal(body.runChecks, null, "nothing was judged");

  for (const [args, kind] of [[["--base", "does-not-exist"], "unresolved-base"], [["--base", "--upload-pack=evil"], "invalid-base"], [["--base", "main..feature"], "invalid-base"]] as const) {
    const result = ci(repo, [...args]);
    assert.equal(result.code, 2, result.stdout);
    assert.equal(result.body?.errorKind ?? kind, kind, result.stdout);
  }
  const usage = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--no-such-flag"], { cwd: repo, encoding: "utf8", env: cleanEnv() });
  assert.equal(usage.status, 2, "a malformed invocation is a configuration error, not a failed change");

  const plain = mkdtempSync(join(tmpdir(), "hk-ci-plain-"));
  git(plain, ["init", "-q"]);
  const unadopted = ci(plain, ["--base", "main"]);
  assert.equal(unadopted.code, 2);
  assert.equal(unadopted.body.errorKind, "not-adopted");
});

test("a shallow checkout is deepened until the merge-base is local", () => {
  const { dir, forkPoint } = origin();
  const repo = checkout(dir, true);
  assert.equal(git(repo, ["rev-parse", "--is-shallow-repository"]), "true");
  const { code, body, stdout } = ci(repo, [], { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" });
  assert.equal(code, 0, stdout);
  assert.equal(body.history.shallow, true);
  assert.equal(body.history.fetch, "fetched");
  assert.ok(body.history.deepened > 0, JSON.stringify(body.history));
  assert.ok(body.history.commands.some((command: string) => /--deepen=\d+/.test(command)));
  assert.equal(body.base.mergeBase, forkPoint);
  assert.deepEqual(body.changed, ["src/core.ts", "test/core.test.ts"]);
});

test("a shallow checkout that cannot be deepened fails as an environment error", () => {
  const { dir } = origin();
  // --no-fetch: local history only.
  const offline = checkout(dir, true);
  git(offline, ["fetch", "-q", "--depth", "1", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const local = ci(offline, ["--base", "origin/main", "--no-fetch"]);
  assert.equal(local.code, 2, local.stdout);
  assert.equal(local.body.errorKind, "shallow-history");
  assert.match(local.body.errors[0], /fetch-depth: 0.*GIT_DEPTH: 0/);
  assert.equal(local.body.history.fetch, "skipped");
  // What did resolve is still reported, so the job log shows how far it got.
  assert.equal(local.body.base.ref, "refs/remotes/origin/main");
  assert.match(local.body.base.commit, /^[0-9a-f]{40}$/);
  assert.equal(local.body.base.mergeBase, null);

  // The remote is gone after checkout: the base is local, deepening is impossible.
  const unreachable = checkout(dir, true);
  git(unreachable, ["fetch", "-q", "--depth", "1", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  git(unreachable, ["remote", "set-url", "origin", join(dir, "missing")]);
  const failed = ci(unreachable, ["--base", "main"]);
  assert.equal(failed.code, 2, failed.stdout);
  assert.equal(failed.body.errorKind, "shallow-history");
  assert.equal(failed.body.history.fetch, "failed");
  assert.match(failed.body.errors[0], /deepening from origin failed/);
  const text = spawnSync(TSX, [CLI, "ci", "--repo", unreachable, "--base", "main"], { cwd: unreachable, encoding: "utf8", env: cleanEnv() });
  assert.equal(text.status, 2);
  assert.match(text.stdout, /could not fetch main from origin/);
  assert.match(text.stdout, /ci: ERROR — the change was not judged \(exit 2\)/);
});

test("unrelated history is an environment error", () => {
  const { dir } = origin();
  git(dir, ["checkout", "-q", "--orphan", "unrelated"]);
  commit(dir, "unrelated root");
  git(dir, ["checkout", "-q", "main"]);
  const repo = checkout(dir, false);
  const { code, body } = ci(repo, ["--base", "unrelated"]);
  assert.equal(code, 2);
  assert.equal(body.errorKind, "no-merge-base");
});

test("a failing check and a failing verify are check failures (exit 1)", () => {
  const { dir } = origin();
  const repo = checkout(dir, false);
  write(repo, "src/core.ts", "export const value = 'broken';\n");
  write(repo, "test/core.test.ts", "// covers broken\n");
  commit(repo, "break the check");
  const broken = ci(repo, ["--base", "main"]);
  assert.equal(broken.code, 1, broken.stdout);
  assert.deepEqual({ status: broken.body.status, errorKind: broken.body.errorKind }, { status: "failed", errorKind: null });
  assert.deepEqual(broken.body.checks.map((check: any) => [check.id, check.status]), [["test", "failed"]]);
  assert.equal(broken.body.runChecks.failed[0].cmd, "node checks/test.mjs");
  assert.equal(broken.body.verifyPassed, true);
  const text = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--base", "main"], { cwd: repo, encoding: "utf8", env: cleanEnv() });
  assert.equal(text.status, 1);
  assert.match(text.stdout, /ERR {2}test: FAILED \(exit 1\) — node checks\/test\.mjs/);
  assert.match(text.stdout, /ci: FAILED/);

  // Checks pass, an invariant does not.
  write(repo, "src/core.ts", "export const value = 5; // TODO\n");
  write(repo, "test/core.test.ts", "// covers 5\n");
  commit(repo, "violate an invariant");
  const invariant = ci(repo, ["--base", "main"]);
  assert.equal(invariant.code, 1, invariant.stdout);
  assert.equal(invariant.body.verifyPassed, false);
  assert.deepEqual(invariant.body.checks.map((check: any) => check.status), ["passed"]);
  assert.ok(invariant.body.verify.messages.some((message: any) => message.level === "error" && /no-todo-in-src: 1 violation/.test(message.text)));

  // A missing test touch is blocking in CI even if a local run-checks waived it: waivers are local state.
  write(repo, "src/core.ts", "export const value = 5;\n");
  const clean = commit(repo, "fix the invariant");
  write(repo, "src/core.ts", "export const value = 6;\n");
  commit(repo, "source without test");
  const waived = spawnSync(
    TSX,
    [CLI, "run-checks", "--repo", repo, "--base", clean, "--waive", "missing-test-touch", "--where", "core", "--reason", "local only"],
    { cwd: repo, encoding: "utf8", env: cleanEnv() },
  );
  assert.equal(waived.status, 0, waived.stdout);
  const gap = ci(repo, ["--base", clean]);
  assert.equal(gap.code, 1, gap.stdout);
  assert.ok(gap.body.blockingGaps.some((item: any) => item.kind === "missing-test-touch" && item.where === "core"));
  const gapText = spawnSync(TSX, [CLI, "ci", "--repo", repo, "--base", clean], { cwd: repo, encoding: "utf8", env: cleanEnv() });
  assert.match(gapText.stdout, /waivers recorded by a local run-checks do not apply in CI/);
});
