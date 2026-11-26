import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installHooksCmd } from "../src/commands/install-hooks";
import { syncCmd } from "../src/commands/sync";
import { inspectAgentHookStatus } from "../src/hook-status";
import { manualValidationSession, recordValidationEvidence, startValidationSession } from "../src/validation-state";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

const MANIFEST = `spec: ai-harness/v0
identity:
  name: hook-fixture
  summary: lifecycle hook fixture
capabilities:
  test:
    run: 'node -e "if (process.env.HK_TEST_FAIL) { console.error(process.env.HK_TEST_MESSAGE); process.exit(1) }"'
modules:
  - name: core
    role: fixture code
    entry: [src/core.ts]
    owns: [src/**]
    tests: [test/**]
    checks: [test]
    test_touch: required
validation:
  required_coverage: [src/**]
  policies:
    test_touch_default: advisory
`;

function write(repo: string, rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commit(repo: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", message], {
    cwd: repo,
  });
}

const LOCK = (version: string) =>
  JSON.stringify({
    schema: "ai-harness/upgrade-state/v1",
    package: "@erzhe/harness-kit",
    version,
    manifestSpec: "ai-harness/v0",
    appliedMigrations: ["upgrade-state-v1"],
  }) + "\n";

function fixture(manifest = MANIFEST): string {
  const repo = mkdtempSync(join(tmpdir(), "hk-hook-event-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  write(repo, ".agents/manifest.yaml", manifest);
  write(repo, "src/core.ts", "export const value = 1;\n");
  write(repo, "test/core.test.ts", "// initial coverage\n");
  syncCmd(repo, { createEntry: true });
  commit(repo, "initial");
  return repo;
}

function hook(
  repo: string,
  agent: "claude" | "cursor" | "codex",
  event: "session-start" | "stop",
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI, "hook-event", "--repo", repo, "--agent", agent, "--event", event], {
    cwd: repo,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function installedHook(
  repo: string,
  agent: "claude" | "cursor" | "codex",
  event: "session-start" | "stop",
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const runner = join(repo, ".agents", "hooks", "harness-agent-hook.sh");
  const result = spawnSync("bash", [runner, agent, event], {
    cwd: repo,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HARNESS_KIT_CMD: `${TSX} ${CLI}`, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("thin Stop without SessionStart asks for deliver, never a new session", () => {
  const repo = fixture();
  write(repo, ".agents/harness.lock.json", LOCK("1.2.3"));
  commit(repo, "pin harness");
  write(repo, "src/core.ts", "export const value = 2;\n");
  const claude = hook(repo, "claude", "stop", { session_id: "no-session-start" });
  assert.equal(claude.status, 0);
  assert.equal(JSON.parse(claude.stdout).decision, "block");
  // The block reason must be runnable without a global install: the lock-pinned npx form.
  // It names the gated root explicitly: from a nested target's directory, `--repo .` would deliver the wrong target.
  assert.ok(
    JSON.parse(claude.stdout).reason.includes(`Run: npx -y @erzhe/harness-kit@1.2.3 deliver --repo ${realpathSync(repo)}\n`),
    JSON.parse(claude.stdout).reason,
  );
  assert.doesNotMatch(JSON.parse(claude.stdout).reason, /Start a new agent session|SessionStart baseline/);

  const cursor = hook(repo, "cursor", "stop", { conversation_id: "no-session-start" });
  assert.equal(cursor.status, 0);
  assert.match(JSON.parse(cursor.stdout).followup_message, /npx -y @erzhe\/harness-kit@1\.2\.3 deliver/);
  assert.doesNotMatch(JSON.parse(cursor.stdout).followup_message, /Start a new agent session/);
});

test("execute-mode Stop applies deliver's inherited context-freshness rule", () => {
  const repo = fixture(`${MANIFEST}knowledge:
  - path: knowledge/policy.md
    authority: policy
    binds: [package.json]
`);
  write(repo, "package.json", '{ "name": "fixture", "version": "1.0.0" }\n');
  write(repo, ".agents/knowledge/policy.md", "# Policy\n");
  const review = spawnSync(TSX, [CLI, "record-context-review", "--repo", repo, "--path", "knowledge/policy.md", "--reason", "fixture"], {
    encoding: "utf8",
  });
  assert.equal(review.status, 0, review.stderr + review.stdout);
  commit(repo, "reviewed policy");
  // Mainline bumps the bound file without a review: stale before any task starts.
  write(repo, "package.json", '{ "name": "fixture", "version": "1.0.1" }\n');
  commit(repo, "bump");

  const executeEnv = { HARNESS_KIT_STOP_MODE: "execute" };
  const payload = { session_id: "inherited-session" };
  assert.equal(hook(repo, "codex", "session-start", payload, executeEnv).status, 0);
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  const allowed = hook(repo, "codex", "stop", payload, executeEnv);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "", allowed.stdout);

  // Touching the bound source inside the session makes the staleness this session's work.
  write(repo, "package.json", '{ "name": "fixture", "version": "1.0.2" }\n');
  const blocked = hook(repo, "codex", "stop", payload, executeEnv);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, /knowledge:agents:knowledge\/policy\.md/);
});

function evidenceJson(repo: string): any {
  const result = spawnSync(TSX, [CLI, "evidence", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8" });
  return JSON.parse(result.stdout);
}

test("default thin Stop leaves lifecycle proof: SessionStart, each Stop, and the deliver stamp it accepted", () => {
  const repo = fixture();
  assert.equal(installHooksCmd(repo, { stop: true, agents: ["claude"] }), 0);
  commit(repo, "install lifecycle hooks");
  const payload = { session_id: "thin-proof" };
  assert.equal(hook(repo, "claude", "session-start", payload).status, 0);

  let body = evidenceJson(repo);
  assert.equal(body.lifecycle.agent, "claude");
  assert.equal(body.lifecycle.configurationCurrent, true);
  assert.equal(body.lifecycle.stop, null);
  assert.equal(body.hookActive, false);

  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  const blocked = hook(repo, "claude", "stop", payload);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  body = evidenceJson(repo);
  assert.equal(body.lifecycle.stop.mode, "thin");
  assert.equal(body.lifecycle.stop.decision, "block");
  assert.equal(body.lifecycle.stop.reason, "no-stamp");
  assert.equal(body.hookActive, false);
  const blockedStatus = inspectAgentHookStatus(repo);
  assert.equal(blockedStatus.state, "degraded");
  assert.ok(blockedStatus.issues.some((issue) => /latest lifecycle evidence: claude Stop blocked \(no-stamp\)/.test(issue)));

  const delivered = spawnSync(TSX, [CLI, "deliver", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8" });
  assert.equal(delivered.status, 0, delivered.stdout);
  const allowed = hook(repo, "claude", "stop", { ...payload, stop_hook_active: true });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), "");

  body = evidenceJson(repo);
  assert.equal(body.hookActive, true, JSON.stringify(body.lifecycle));
  // The latest record is the deliver this session ran from its shell; the proof comes from the lifecycle session.
  assert.equal(body.agent, "claude");
  assert.equal(body.hookActiveSource, "lifecycle");
  assert.deepEqual(
    { kind: body.record.kind, agent: body.record.agent, hostSessionId: body.record.hostSessionId },
    { kind: "agent-deliver", agent: "claude", hostSessionId: "thin-proof" },
  );
  // The top-level configuration flag follows the hook proof, never false beside a current lifecycle.
  assert.equal(body.hookConfigurationCurrent, true);
  assert.equal(body.lifecycle.configurationCurrent, true);
  assert.equal(body.lifecycle.hostSessionId, "thin-proof");
  const text = spawnSync(TSX, [CLI, "evidence", "--repo", repo], { cwd: repo, encoding: "utf8" }).stdout;
  assert.match(text, /a command, not hook proof/);
  assert.match(text, /hook proof \(hookActive\): yes, from the lifecycle session/);
  assert.equal(body.lifecycle.stop.decision, "allow");
  assert.equal(body.lifecycle.stop.reason, "stamp");
  assert.equal(body.lifecycle.evidenceSource, "deliver-stamp");
  assert.equal(body.lifecycle.evidenceValid, true);
  // The stamp itself still comes from deliver: observing a Stop never moves the latest pointer.
  assert.equal(body.record.kind, "agent-deliver");
  assert.equal(body.stamp.status, "accepted");
  const active = inspectAgentHookStatus(repo);
  assert.equal(active.state, "active");
  assert.equal(active.evidenceAgent, "claude");

  // Another Stop still sees the same stamp, so recording observations cannot change decisions.
  assert.equal(hook(repo, "claude", "stop", payload).stdout.trim(), "");

  // A later edit makes the delivery stamp stale, not the hook proof: the hook
  // ran and accepted verified evidence under this configuration.
  write(repo, "src/core.ts", "export const value = 3;\n");
  const later = evidenceJson(repo);
  assert.equal(later.hookActive, true);
  assert.equal(later.lifecycle.evidencePassed, true);
  assert.equal(later.lifecycle.evidenceCurrent, false);
  assert.equal(later.lifecycle.evidenceValid, false);
  assert.equal(later.stamp.status, "stale");
  assert.equal(inspectAgentHookStatus(repo).state, "active");
});

test("a thin Stop on a clean tree is observed but is not gate proof", () => {
  const repo = fixture();
  assert.equal(installHooksCmd(repo, { stop: true, agents: ["claude"] }), 0);
  commit(repo, "install lifecycle hooks");
  const payload = { session_id: "thin-clean" };
  assert.equal(hook(repo, "claude", "session-start", payload).status, 0);
  assert.equal(hook(repo, "claude", "stop", payload).stdout.trim(), "");
  const body = evidenceJson(repo);
  assert.equal(body.lifecycle.stop.decision, "allow");
  assert.equal(body.lifecycle.stop.reason, "clean");
  assert.equal(body.lifecycle.evidenceSource, null);
  assert.equal(body.hookActive, false);
  assert.equal(inspectAgentHookStatus(repo).state, "configured");

  // A Stop without its SessionStart records nothing.
  assert.equal(hook(repo, "claude", "stop", { session_id: "never-started" }).stdout.trim(), "");
  assert.equal(evidenceJson(repo).lifecycle.session, body.lifecycle.session);
});

test("thin Stop allows clean trees and accepted deliver stamps", () => {
  const repo = fixture();
  // Clean: allow without SessionStart.
  const clean = hook(repo, "claude", "stop", { session_id: "clean-1" });
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout.trim(), "");

  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  const blocked = hook(repo, "claude", "stop", { session_id: "dirty-1" });
  assert.equal(JSON.parse(blocked.stdout).decision, "block");

  const delivered = spawnSync(TSX, [CLI, "deliver", "--repo", repo, "--json"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(delivered.status, 0, delivered.stderr + delivered.stdout);
  const allowed = hook(repo, "claude", "stop", { session_id: "dirty-1" });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), "");
});

test("a SessionStart after an accepted worktree deliver does not hide the stamp that still covers the change", () => {
  const repo = fixture();
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  // Delivered before any session existed: worktree scope, base HEAD.
  const delivered = spawnSync(TSX, [CLI, "deliver", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8" });
  assert.equal(delivered.status, 0, delivered.stderr + delivered.stdout);
  assert.equal(JSON.parse(delivered.stdout).scope, "worktree");

  // SessionStart records a task at the same base; the same change stays accepted.
  assert.equal(hook(repo, "claude", "session-start", { session_id: "after-deliver" }).status, 0);
  const stop = hook(repo, "claude", "stop", { session_id: "after-deliver" });
  assert.equal(stop.status, 0);
  assert.equal(stop.stdout.trim(), "", stop.stdout);

  // A further change still needs a new deliver.
  write(repo, "src/extra.ts", "export const extra = 1;\n");
  assert.equal(JSON.parse(hook(repo, "claude", "stop", { session_id: "after-deliver" }).stdout).decision, "block");
});

test("execute mode: SessionStart base + Stop runs checks without demanding a new session", () => {
  const repo = fixture();
  writeFileSync(join(repo, ".git", "info", "exclude"), ".codex/\n");
  assert.equal(installHooksCmd(repo, { stop: true, agents: ["codex"] }), 0);
  commit(repo, "install lifecycle hooks");
  const payload = { session_id: "session-1" };
  const executeEnv = { HARNESS_KIT_STOP_MODE: "execute" };
  assert.equal(installedHook(repo, "codex", "session-start", payload, executeEnv).status, 0);

  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers value 2\n");
  commit(repo, "task change");

  // Resumed SessionStart must keep the original task/session base.
  assert.equal(installedHook(repo, "codex", "session-start", payload, executeEnv).status, 0);

  const failed = installedHook(
    repo,
    "codex",
    "stop",
    { ...payload, stop_hook_active: true },
    { ...executeEnv, HK_TEST_FAIL: "1", HK_TEST_MESSAGE: "backend assertion exploded" },
  );
  assert.equal(failed.status, 0);
  assert.equal(JSON.parse(failed.stdout).decision, "block");
  const failedReason = JSON.parse(failed.stdout).reason as string;
  assert.match(failedReason, /check test failed/);
  assert.match(failedReason, /run: node -e/);
  assert.match(failedReason, /backend assertion exploded/);
  assert.doesNotMatch(failedReason, /Start a new agent session|Prove the lifecycle Hook in a fresh Agent session/);

  const passed = installedHook(repo, "codex", "stop", { ...payload, stop_hook_active: true }, executeEnv);
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, "");

  const evidence = spawnSync(TSX, [CLI, "evidence", "--repo", repo, "--json"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(evidence.status, 0);
  const body = JSON.parse(evidence.stdout);
  assert.equal(body.evidence.status, "verified");
  assert.deepEqual(body.evidence.changed, ["src/core.ts", "test/core.test.ts"]);
  assert.equal(body.evidence.verifyPassed, true);
  assert.equal(body.stamp?.status, "accepted");
  assert.equal(body.lifecycle.stop.mode, "execute");
  assert.equal(body.lifecycle.stop.decision, "allow");
  assert.equal(body.lifecycle.stop.reason, "checks");
  assert.equal(body.lifecycle.evidenceSource, "run-checks");
  assert.equal(body.hookActive, true);
  assert.ok(Array.isArray(body.nextActions));
  assert.equal(
    body.nextActions.filter((a: { priority: string }) => a.priority === "required").length,
    0,
  );
  const hookStatus = inspectAgentHookStatus(repo);
  assert.equal(hookStatus.state, "active");
  assert.equal(hookStatus.evidenceAgent, "codex");
  const manual = manualValidationSession(repo, null, "manual-latest-pointer");
  recordValidationEvidence(repo, manual, {
    schema: "ai-harness/validation-evidence/v1",
    status: "verified",
    ok: true,
    requestedBase: "HEAD",
    resolvedBase: null,
    fingerprint: "stale-manual-fingerprint",
    changed: [],
    affected: [],
    checks: [],
    gaps: [],
    notes: [],
    waivers: [],
    errors: [],
    createdAt: new Date().toISOString(),
    runChecksStatus: "verified",
    verifyPassed: true,
  });
  assert.equal(inspectAgentHookStatus(repo).state, "active", "manual commands must not hide valid hook evidence");

  const hooksPath = join(repo, ".codex", "hooks.json");
  const originalHooks = readFileSync(hooksPath, "utf8");
  const overridden = JSON.parse(originalHooks);
  overridden.hooks.SessionStart[0].hooks[0].command =
    `HARNESS_KIT_CMD=true ${overridden.hooks.SessionStart[0].hooks[0].command}`;
  // The buffered Stop command reads stdin first; the override goes where the runner starts.
  overridden.hooks.Stop[0].hooks[0].command = overridden.hooks.Stop[0].hooks[0].command.replace(
    `printf '%s' "$INPUT" | bash `,
    `printf '%s' "$INPUT" | HARNESS_KIT_CMD=true bash `,
  );
  writeFileSync(hooksPath, JSON.stringify(overridden));
  assert.equal(inspectAgentHookStatus(repo).state, "degraded");
  const rebound = spawnSync(TSX, [CLI, "evidence", "--repo", repo, "--session", body.session, "--json"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(rebound.status, 0, "delivery stamp remains valid even when it no longer proves Hook ACTIVE");
  assert.equal(JSON.parse(rebound.stdout).valid, true);
  assert.equal(JSON.parse(rebound.stdout).hookActive, false);
  writeFileSync(hooksPath, originalHooks);
  assert.equal(inspectAgentHookStatus(repo).state, "active");

  write(repo, "src/core.ts", "export const value = 3;\n");
  const stale = spawnSync(TSX, [CLI, "evidence", "--repo", repo, "--session", body.session, "--json"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stdout).stale, true);
  // The record no longer covers the change, but it still proves the hooks ran.
  assert.equal(JSON.parse(stale.stdout).lifecycle.evidenceCurrent, false);
  assert.equal(inspectAgentHookStatus(repo).state, "active");
});

test("Codex linked dispatcher: config change without code changes does not demand a new session", () => {
  const main = fixture();
  const linked = join(mkdtempSync(join(tmpdir(), "hk-hook-event-linked-parent-")), "linked");
  execFileSync("git", ["worktree", "add", "-q", "--detach", linked, "HEAD"], { cwd: main });
  const codexHome = mkdtempSync(join(tmpdir(), "hk-hook-event-codex-home-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    assert.equal(
      installHooksCmd(linked, { stop: true, agents: ["codex"], allowUserDispatcher: true }),
      0,
    );
    const dispatcher = join(codexHome, "harness-kit", "codex-linked-dispatch-v1.cjs");
    const env = { ...process.env, HARNESS_KIT_CMD: `${TSX} ${CLI}`, HARNESS_KIT_STOP_MODE: "execute" };
    const payload = JSON.stringify({ session_id: "linked-session" });
    const start = spawnSync(process.execPath, [dispatcher, "session-start"], {
      cwd: linked,
      input: payload,
      encoding: "utf8",
      env,
    });
    assert.equal(start.status, 0, start.stderr);

    writeFileSync(dispatcher, readFileSync(dispatcher, "utf8") + "// changed after SessionStart\n");
    // No repo code change → deliver no-change / thin allow path must not ask for a new session.
    const stop = spawnSync(process.execPath, [dispatcher, "stop"], {
      cwd: linked,
      input: payload,
      encoding: "utf8",
      env,
    });
    assert.equal(stop.status, 0, stop.stderr);
    if (stop.stdout.trim()) {
      const body = JSON.parse(stop.stdout);
      assert.doesNotMatch(body.reason ?? body.followup_message ?? "", /Start a new agent session/);
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("a hung verify contract is timed out early enough to return the client's blocking protocol", () => {
  const repo = fixture(`${MANIFEST}
contracts:
  - id: hung-contract
    kind: other
    desc: timeout fixture
    check: 'node -e "setTimeout(() => {}, 5000)"'
`);
  const payload = { session_id: "hung-verify" };
  assert.equal(hook(repo, "claude", "session-start", payload).status, 0);
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers value 2\n");

  const started = Date.now();
  const stopped = hook(repo, "claude", "stop", payload, {
    HARNESS_KIT_VERIFY_BUDGET_MS: "75",
    HARNESS_KIT_STOP_MODE: "execute",
  });
  assert.ok(Date.now() - started < 3_000, "hook returns before the client-level timeout");
  assert.equal(stopped.status, 0);
  const response = JSON.parse(stopped.stdout);
  assert.equal(response.decision, "block");
  assert.match(response.reason, /timed out|budget exhausted/);
});

test("a Stop the client re-runs right after a block, with nothing changed, exits the loop unverified", () => {
  const repo = fixture();
  assert.equal(installHooksCmd(repo, { stop: true, agents: ["claude"] }), 0);
  commit(repo, "install lifecycle hooks");
  const payload = { session_id: "loop-exit" };
  assert.equal(hook(repo, "claude", "session-start", payload).status, 0);
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");

  const first = hook(repo, "claude", "stop", payload);
  assert.equal(JSON.parse(first.stdout).decision, "block");
  assert.match(JSON.parse(first.stdout).reason, /not blocked twice in a row/);

  // Progress (any change) is still gated.
  write(repo, "test/core.test.ts", "// covers 2, again\n");
  const progressed = hook(repo, "claude", "stop", { ...payload, stop_hook_active: true });
  assert.equal(JSON.parse(progressed.stdout).decision, "block");

  // The Agent could not deliver and stopped again on the same change: allowed, never verified.
  const exited = hook(repo, "claude", "stop", { ...payload, stop_hook_active: true });
  assert.equal(exited.status, 0);
  const notice = JSON.parse(exited.stdout);
  assert.equal(notice.decision, undefined);
  assert.match(notice.systemMessage, /WITHOUT verified delivery/);
  const body = evidenceJson(repo);
  assert.equal(body.lifecycle.stop.decision, "allow");
  assert.equal(body.lifecycle.stop.reason, "loop-exit");
  assert.equal(body.hookActive, false);
  const status = inspectAgentHookStatus(repo);
  assert.equal(status.state, "degraded");
  assert.ok(status.issues.some((issue) => /ended without verified delivery \(loop-exit/.test(issue)), status.issues.join("; "));

  // The next turn starts gated again.
  assert.equal(JSON.parse(hook(repo, "claude", "stop", payload).stdout).decision, "block");
});

test("the loop exit also covers a Stop without SessionStart and Cursor's loop_count", () => {
  const repo = fixture();
  write(repo, "src/core.ts", "export const value = 2;\n");
  const payload = { session_id: "mid-session-install" };
  assert.equal(JSON.parse(hook(repo, "claude", "stop", payload).stdout).decision, "block");
  // Not continuing: a fresh turn on the same change is blocked again.
  assert.equal(JSON.parse(hook(repo, "claude", "stop", payload).stdout).decision, "block");
  const exited = hook(repo, "claude", "stop", { ...payload, stop_hook_active: true });
  assert.match(JSON.parse(exited.stdout).systemMessage, /WITHOUT verified delivery/);

  const cursor = { conversation_id: "cursor-loop" };
  assert.match(JSON.parse(hook(repo, "cursor", "stop", { ...cursor, loop_count: 0 }).stdout).followup_message, /deliver/);
  assert.deepEqual(JSON.parse(hook(repo, "cursor", "stop", { ...cursor, loop_count: 1 }).stdout), {});

  // Execute mode uses the same exit.
  const executeEnv = { HARNESS_KIT_STOP_MODE: "execute", HK_TEST_FAIL: "1", HK_TEST_MESSAGE: "red" };
  const codex = { session_id: "execute-loop" };
  assert.equal(hook(repo, "codex", "session-start", codex, executeEnv).status, 0);
  write(repo, "test/core.test.ts", "// covers 2\n");
  assert.equal(JSON.parse(hook(repo, "codex", "stop", codex, executeEnv).stdout).decision, "block");
  const codexExit = hook(repo, "codex", "stop", { ...codex, stop_hook_active: true }, executeEnv);
  assert.equal(codexExit.status, 0);
  assert.equal(codexExit.stdout.trim(), "");
  assert.match(codexExit.stderr, /WITHOUT verified delivery/);
});

test("a session that started under the previous runner is rebound when only Harness's own hook entries changed", () => {
  const repo = fixture();
  assert.equal(installHooksCmd(repo, { stop: true, agents: ["claude"] }), 0);
  commit(repo, "install lifecycle hooks");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  // What a 0.8.0 SessionStart left behind: another runner's fingerprint, no foreign-config fingerprint.
  const before = { session_id: "upgraded-mid-session" };
  startValidationSession({ repo, agent: "claude", sessionId: before.session_id, baseSha: head, initialFingerprint: "x", initialDirty: [], hookConfigFingerprint: "f".repeat(64) });
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  assert.equal(spawnSync(TSX, [CLI, "deliver", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8" }).status, 0);
  assert.equal(hook(repo, "claude", "stop", before).stdout.trim(), "");
  let body = evidenceJson(repo);
  assert.equal(body.lifecycle.configurationCurrent, true);
  assert.equal(body.lifecycle.stop.rebound, true);
  assert.equal(body.hookActive, true, JSON.stringify(body.lifecycle));
  assert.match(spawnSync(TSX, [CLI, "evidence", "--repo", repo], { cwd: repo, encoding: "utf8" }).stdout, /rebound to the hook configuration refreshed during the session/);

  // A third-party hook edit is not a Harness refresh: that session must prove it afresh.
  const other = { session_id: "third-party-edit" };
  startValidationSession({ repo, agent: "claude", sessionId: other.session_id, baseSha: head, initialFingerprint: "x", initialDirty: [], hookConfigFingerprint: "e".repeat(64) });
  const settingsPath = join(repo, ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks.Stop.unshift({ hooks: [{ type: "command", command: "echo third-party" }] });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  assert.equal(spawnSync(TSX, [CLI, "deliver", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8" }).status, 0);
  assert.equal(hook(repo, "claude", "stop", other).stdout.trim(), "");
  body = evidenceJson(repo);
  assert.equal(body.lifecycle.hostSessionId, "third-party-edit");
  assert.equal(body.lifecycle.configurationCurrent, false);
  assert.equal(body.lifecycle.stop.rebound, undefined);
  assert.equal(body.hookActive, false);
});

test("a 0.8.1 session records its foreign hook config and is rebound after an in-session refresh", () => {
  const repo = fixture();
  assert.equal(installHooksCmd(repo, { stop: true, agents: ["claude"] }), 0);
  const settingsPath = join(repo, ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  // Start from the 0.8.1 Stop command (still a managed entry).
  settings.hooks.Stop[0].hooks[0].command =
    `bash "$(git rev-parse --show-toplevel)/.agents/hooks/harness-agent-hook.sh" claude stop || ` +
    `grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' || ` +
    `printf '%s\\n' '{"decision":"block","reason":"harness-kit hook runner is missing or failed; run the pinned deliver command from AGENTS.md manually"}'`;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  commit(repo, "older managed fallback");
  const payload = { session_id: "refresh-in-session" };
  assert.equal(hook(repo, "claude", "session-start", payload).status, 0);
  // Until this turn's Stop runs there is no hook proof; the text says which Stop gives it.
  assert.match(
    spawnSync(TSX, [CLI, "evidence", "--repo", repo], { cwd: repo, encoding: "utf8" }).stdout,
    /no Stop observed yet \(the Stop that ends this turn judges the stamp/,
  );
  // Reinstall during the session (what upgrade's refresh does): only managed bytes change.
  assert.equal(installHooksCmd(repo, { stop: true, agents: ["claude"] }), 0);
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  assert.equal(spawnSync(TSX, [CLI, "deliver", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8" }).status, 0);
  assert.equal(hook(repo, "claude", "stop", payload).stdout.trim(), "");
  const body = evidenceJson(repo);
  assert.equal(body.lifecycle.stop.rebound, true);
  assert.equal(body.hookActive, true);
});

test("a deliver the Agent ran from its own shell names the session whose task record scoped it", () => {
  const repo = fixture();
  const payload = { session_id: "shell-deliver" };
  assert.equal(hook(repo, "claude", "session-start", payload).status, 0);
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  assert.equal(spawnSync(TSX, [CLI, "deliver", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8" }).status, 0);
  let body = evidenceJson(repo);
  // Top-level agent / createdAt name the delivering session and this evidence,
  // not the worktree's manual record file, which an earlier task created.
  assert.deepEqual(
    { agent: body.agent, kind: body.record.kind, recordAgent: body.record.agent, hostSessionId: body.record.hostSessionId },
    { agent: "claude", kind: "agent-deliver", recordAgent: "claude", hostSessionId: "shell-deliver" },
  );
  assert.deepEqual(body.record.deliveredIn, { agent: "claude", hostSessionId: "shell-deliver" });
  assert.equal(body.createdAt, body.evidence.createdAt);
  assert.equal(body.record.createdAt, body.evidence.createdAt);
  assert.equal(body.stamp.session, body.session);
  let text = spawnSync(TSX, [CLI, "evidence", "--repo", repo], { cwd: repo, encoding: "utf8" }).stdout;
  assert.match(text, /agent: claude\n/);
  assert.match(text, /\(this worktree's deliver record\)/);
  assert.match(text, /stamp source: deliver run by claude session shell-deliver \(its task record scoped this change\) — a command, not hook proof/);

  // A later session's deliver is its own: the shared record file keeps its first time only.
  const firstRecordAt = body.record.sessionCreatedAt;
  assert.equal(hook(repo, "claude", "session-start", { session_id: "next-session" }).status, 0);
  write(repo, "src/core.ts", "export const value = 3;\n");
  write(repo, "test/core.test.ts", "// covers 3\n");
  assert.equal(spawnSync(TSX, [CLI, "deliver", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8" }).status, 0);
  body = evidenceJson(repo);
  assert.equal(body.record.hostSessionId, "next-session");
  assert.equal(body.record.sessionCreatedAt, firstRecordAt);
  assert.notEqual(body.createdAt, firstRecordAt);

  // Without a session's task record (manual task-start), it is a plain manual deliver.
  assert.equal(spawnSync(TSX, [CLI, "task-start", "--repo", repo], { cwd: repo, encoding: "utf8" }).status, 0);
  write(repo, "src/core.ts", "export const value = 4;\n");
  write(repo, "test/core.test.ts", "// covers 4\n");
  assert.equal(spawnSync(TSX, [CLI, "deliver", "--repo", repo, "--json"], { cwd: repo, encoding: "utf8" }).status, 0);
  body = evidenceJson(repo);
  assert.deepEqual(
    { agent: body.agent, kind: body.record.kind, hostSessionId: body.record.hostSessionId, deliveredIn: body.record.deliveredIn },
    { agent: "manual", kind: "manual-deliver", hostSessionId: null, deliveredIn: null },
  );
  text = spawnSync(TSX, [CLI, "evidence", "--repo", repo], { cwd: repo, encoding: "utf8" }).stdout;
  assert.match(text, /stamp source: deliver\/manual — this record is not hook proof/);
});
