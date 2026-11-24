import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const PACKAGE_VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  version: string;
}).version;

test("run-checks exposes scoped waiver and evidence options", () => {
  const result = spawnSync(TSX, [CLI, "run-checks", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--where <scope>/);
  assert.match(result.stdout, /--session <token>/);
});

test("deliver and task-start are public finish-gate commands", () => {
  const deliver = spawnSync(TSX, [CLI, "deliver", "--help"], { encoding: "utf8" });
  assert.equal(deliver.status, 0);
  assert.match(deliver.stdout, /run-checks \+ verify → stamp|run-checks \+ verify/);
  assert.match(deliver.stdout, /--base <ref>/);

  const taskStart = spawnSync(TSX, [CLI, "task-start", "--help"], { encoding: "utf8" });
  assert.equal(taskStart.status, 0);
  assert.match(taskStart.stdout, /task-start base|base SHA|current HEAD/i);
});

test("doctor and verify expose an explicit details view without changing JSON mode", () => {
  const doctor = spawnSync(TSX, [CLI, "doctor", "--help"], { encoding: "utf8" });
  assert.equal(doctor.status, 0);
  assert.match(doctor.stdout, /--details/);

  const verify = spawnSync(TSX, [CLI, "verify", "--help"], { encoding: "utf8" });
  assert.equal(verify.status, 0);
  assert.match(verify.stdout, /--details/);
  assert.match(verify.stdout, /--json/);
});

test("upgrade exposes read-only and machine-readable modes", () => {
  const result = spawnSync(TSX, [CLI, "upgrade", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--check/);
  assert.match(result.stdout, /--json/);
});

test("record-context-review exposes an explicit Agent review contract", () => {
  const result = spawnSync(TSX, [CLI, "record-context-review", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--path <knowledge-path>/);
  assert.match(result.stdout, /--module <name>/);
  assert.match(result.stdout, /--reason <text>/);
  assert.match(result.stdout, /--session <token>/);
});

test("adoption and native Git hooks expose explicit evidence/scope acknowledgements", () => {
  const sync = spawnSync(TSX, [CLI, "sync", "--help"], { encoding: "utf8" });
  assert.equal(sync.status, 0);
  assert.match(sync.stdout, /--adopt-existing/);
  assert.match(sync.stdout, /--candidate <dir>/);
  assert.match(sync.stdout, /--audit <receipt>/);

  const prepare = spawnSync(TSX, [CLI, "prepare-adoption", "--help"], { encoding: "utf8" });
  assert.equal(prepare.status, 0);
  assert.match(prepare.stdout, /--out <dir>/);

  const audit = spawnSync(TSX, [CLI, "record-adoption-audit", "--help"], { encoding: "utf8" });
  assert.equal(audit.status, 0);
  assert.match(audit.stdout, /--verdict <pass\|fail>/);
  assert.match(audit.stdout, /--report <file>/);
  assert.match(audit.stdout, /--reason <text>/);

  const hooks = spawnSync(TSX, [CLI, "install-hooks", "--help"], { encoding: "utf8" });
  assert.equal(hooks.status, 0);
  assert.match(hooks.stdout, /--allow-shared-git-hooks/);
  assert.match(hooks.stdout, /--allow-user-dispatcher/);
});

test("install-hooks rejects unknown agent names instead of silently writing a config", () => {
  const result = spawnSync(TSX, [CLI, "install-hooks", "--stop", "--agents", "claude,unknown"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid --agents value/);
});

test("init refusal is a real nonzero failure, not a successful-looking error", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-cli-init-existing-"));
  mkdirSync(join(repo, ".agents"), { recursive: true });
  writeFileSync(join(repo, ".agents/manifest.yaml"), "spec: ai-harness/v0\nidentity: { name: existing }\n");
  const result = spawnSync(TSX, [CLI, "init", "--repo", repo], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /已存在/);
});

test("init preflights every scaffold target and refuses with zero writes", () => {
  const scaffold = [
    ".agents/manifest.yaml",
    ".agents/harness.lock.json",
    ".agents/knowledge/domain.md",
    ".agents/knowledge/conventions.md",
    ".agents/knowledge/journal/.gitkeep",
    ".agents/playbooks/.gitkeep",
    ".agents/adoption.md",
  ];
  for (const occupied of scaffold) {
    const repo = mkdtempSync(join(tmpdir(), "hk-cli-init-scaffold-"));
    mkdirSync(join(repo, dirname(occupied)), { recursive: true });
    writeFileSync(join(repo, occupied), `existing ${occupied}\n`);

    const result = spawnSync(TSX, [CLI, "init", "--repo", repo], { encoding: "utf8" });
    assert.equal(result.status, 1, occupied);
    assert.match(result.stdout, /init scaffold.*已存在/, occupied);
    assert.equal(readFileSync(join(repo, occupied), "utf8"), `existing ${occupied}\n`);
    for (const target of scaffold) assert.equal(existsSync(join(repo, target)), target === occupied, `${occupied}: ${target}`);
    assert.equal(existsSync(join(repo, ".agents/adoption/legacy-index.json")), false, occupied);
  }
});

test("init --force still snapshots legacy entry bytes before replacing scaffold files", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-cli-init-force-"));
  writeFileSync(join(repo, "AGENTS.md"), "# Existing project rules\n");
  mkdirSync(join(repo, ".agents/knowledge"), { recursive: true });
  writeFileSync(join(repo, ".agents/knowledge/domain.md"), "old scaffold\n");

  const result = spawnSync(TSX, [CLI, "init", "--repo", repo, "--name", "forced", "--force"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(join(repo, ".agents/adoption/legacy/AGENTS.md.pre-harness"), "utf8"), "# Existing project rules\n");
  assert.match(readFileSync(join(repo, ".agents/knowledge/domain.md"), "utf8"), /forced — domain/);
  assert.deepEqual(JSON.parse(readFileSync(join(repo, ".agents/harness.lock.json"), "utf8")), {
    schema: "ai-harness/upgrade-state/v1",
    package: "@erzhe/harness-kit",
    version: PACKAGE_VERSION,
    manifestSpec: "ai-harness/v0",
    appliedMigrations: ["upgrade-state-v1"],
  });
});

test("the real CLI blocks an implicit manual no-change result", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-cli-no-change-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, ".agents"), { recursive: true });
  writeFileSync(join(repo, ".agents", "manifest.yaml"), "spec: ai-harness/v0\nidentity: { name: fixture, summary: fixture }\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", "initial"], {
    cwd: repo,
  });

  const result = spawnSync(TSX, [CLI, "run-checks", "--repo", repo, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).gaps.some((gap: { kind: string }) => gap.kind === "manual-base-required"));
});

test("sync pins generated entries to the lock version and warns when the running CLI differs", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-cli-sync-pin-"));
  mkdirSync(join(repo, ".agents"), { recursive: true });
  writeFileSync(join(repo, ".agents/manifest.yaml"), "spec: ai-harness/v0\nidentity: { name: pinned, summary: pinned }\n");
  writeFileSync(
    join(repo, ".agents/harness.lock.json"),
    JSON.stringify({
      schema: "ai-harness/upgrade-state/v1",
      package: "@erzhe/harness-kit",
      version: "0.0.1",
      manifestSpec: "ai-harness/v0",
      appliedMigrations: ["upgrade-state-v1"],
    }) + "\n",
  );
  const result = spawnSync(TSX, [CLI, "sync", "--repo", repo], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`WARN running harness-kit ${PACKAGE_VERSION.replace(/\./g, "\\.")} but \\.agents/harness\\.lock\\.json pins 0\\.0\\.1`));
  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
  assert.match(agents, /`npx -y @erzhe\/harness-kit@0\.0\.1 deliver`/);
  assert.doesNotMatch(agents, new RegExp(`@${PACKAGE_VERSION.replace(/\./g, "\\.")}`));

  // verify renders with the same lock version, so the pinned entry is not drift.
  const verify = spawnSync(TSX, [CLI, "verify", "--repo", repo, "--json"], { encoding: "utf8" });
  assert.equal(JSON.parse(verify.stdout).messages.some((m: { text: string }) => /drifted/.test(m.text)), false);
});

test("hook and onboarding help describe the default thin Stop and the pinned version", () => {
  const install = spawnSync(TSX, [CLI, "install-hooks", "--help"], { encoding: "utf8" });
  assert.equal(install.status, 0);
  assert.match(install.stdout, /Stop requires an\s+accepted deliver stamp/);
  assert.doesNotMatch(install.stdout, /run-checks \+ verify\s+gate/);

  const onboard = spawnSync(TSX, [CLI, "onboard", "--help"], { encoding: "utf8" });
  assert.equal(onboard.status, 0);
  assert.match(onboard.stdout, /pins this exact\s+version/);
  assert.doesNotMatch(onboard.stdout, /always\s+latest/);
});

function initStarter(files: Record<string, string>): { repo: string; manifest: string } {
  const repo = mkdtempSync(join(tmpdir(), "hk-cli-init-starter-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  const result = spawnSync(TSX, [CLI, "init", "--repo", repo, "--name", "starter"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { repo, manifest: readFileSync(join(repo, ".agents/manifest.yaml"), "utf8") };
}

test("init starts a Go repository from Go commands, not the JS template", () => {
  const { repo, manifest } = initStarter({ "go.mod": "module example.com/svc\n\ngo 1.22\n", "main.go": "package main\n\nfunc main() {}\n" });
  assert.match(manifest, /Starter commands detected from Go \(go\.mod\)/);
  assert.match(manifest, /test: \{ run: "go test \.\/\.\.\." \}/);
  assert.match(manifest, /vet: \{ run: "go vet \.\/\.\.\." \}/);
  assert.doesNotMatch(manifest, /pnpm|no-console-log|src\/\*\*|harness-kit verify/);
  assert.match(manifest, /^invariants: \[\]$/m);
  assert.match(manifest, /no_match: \[diff_check\]/);

  // A fresh starter is deliverable: a change outside every module still selects a real check.
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", "init"], { cwd: repo });
  writeFileSync(join(repo, "main.go"), "package main\n\nfunc main() { println(1) }\n");
  const checks = spawnSync(TSX, [CLI, "run-checks", "--repo", repo, "--base", "HEAD", "--json"], { encoding: "utf8" });
  const report = JSON.parse(checks.stdout);
  assert.deepEqual(report.passed, ["diff_check"], checks.stdout);
  assert.ok(!report.gaps.some((gap: { kind: string }) => gap.kind === "no-checks-selected"));
});

test("init reads the package manager and real scripts of a Node repository", () => {
  const { manifest } = initStarter({
    "package.json": JSON.stringify({ scripts: { build: "tsc", test: 'echo "Error: no test specified" && exit 1', lint: "eslint ." } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "src/index.ts": "export {};\n",
  });
  assert.match(manifest, /Starter commands detected from pnpm \(package\.json\)/);
  assert.match(manifest, /setup: \{ run: "pnpm install" \}/);
  assert.match(manifest, /build: \{ run: "pnpm build" \}/);
  assert.match(manifest, /lint: \{ run: "pnpm lint" \}/);
  // npm's placeholder test script always fails, so it is not offered as a check.
  assert.doesNotMatch(manifest, /test: \{ run:/);
  assert.match(manifest, /id: no-console-log/);

  const npm = initStarter({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "package-lock.json": "{}\n" }).manifest;
  assert.match(npm, /setup: \{ run: "npm ci" \}/);
  assert.match(npm, /test: \{ run: "npm test" \}/);
  // No src/ tree: the src/** examples would match nothing.
  assert.match(npm, /^invariants: \[\]$/m);
});

test("init without a known build file declares only the diff check and asks for real commands", () => {
  const { manifest } = initStarter({ "README.md": "# docs only\n" });
  assert.match(manifest, /Starter commands detected from no known build file/);
  assert.match(manifest, /^capabilities:\n  diff_check: \{ run: "git diff --check \$\{HARNESS_KIT_BASE:-HEAD\}" \}$/m);
});
