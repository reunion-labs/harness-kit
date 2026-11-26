import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { harnessInvocation, lockedHarnessVersion, repoHarnessInvocation } from "../src/harness-cli";
import { type Manifest } from "../src/manifest";
import { renderTargets } from "../src/render";
import {
  initialUpgradeState,
  UPGRADE_REPORT_SCHEMA,
  UPGRADE_STATE_REL,
  upgradeRepository,
  type UpgradeState,
} from "../src/upgrade";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const PACKAGE = "@erzhe/harness-kit";
const TARGET = (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  version: string;
}).version;

const MANIFEST = `spec: ai-harness/v0

identity:
  name: upgrade-fixture
  summary: Upgrade fixture
`;

function commit(repo: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", message],
    { cwd: repo },
  );
}

function fixture(options: { generated?: boolean; lock?: string; agents?: string; manifest?: string } = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "hk-upgrade-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, ".agents"), { recursive: true });
  const manifestSource = options.manifest ?? MANIFEST;
  writeFileSync(join(repo, ".agents/manifest.yaml"), manifestSource);
  if (options.generated !== false) {
    const manifest = YAML.parse(manifestSource) as Manifest;
    // Generated entries pin whatever version the fixture lock records (none -> @latest).
    let harnessVersion: string | null = null;
    try {
      harnessVersion = options.lock ? (JSON.parse(options.lock) as { version?: string }).version ?? null : null;
    } catch {
      harnessVersion = null;
    }
    for (const [path, content] of renderTargets(manifest, { harnessVersion })) {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), options.agents && path === "AGENTS.md" ? options.agents : content);
    }
  }
  if (options.lock !== undefined) writeFileSync(join(repo, UPGRADE_STATE_REL), options.lock);
  commit(repo, "fixture");
  return repo;
}

function upgrade(repo: string, check = false) {
  return upgradeRepository(repo, { packageName: PACKAGE, targetVersion: TARGET, check });
}

test("upgrade --check reports a missing durable state without writing", () => {
  const repo = fixture();
  const beforeManifest = readFileSync(join(repo, ".agents/manifest.yaml"), "utf8");
  const report = upgrade(repo, true);
  assert.equal(report.schema, UPGRADE_REPORT_SCHEMA);
  assert.equal(report.status, "upgrade-available");
  assert.deepEqual(report.pendingMigrations, ["upgrade-state-v1"]);
  // The lock-less entry says @latest; upgrading pins it, so AGENTS.md is part of the plan.
  assert.deepEqual(report.changedFiles, ["AGENTS.md", UPGRADE_STATE_REL]);
  assert.equal(report.hooksChanged, false);
  assert.equal(existsSync(join(repo, UPGRADE_STATE_REL)), false);
  assert.equal(readFileSync(join(repo, ".agents/manifest.yaml"), "utf8"), beforeManifest);
});

test("upgrade applies once, preserves manifest bytes, and is current after commit", () => {
  const repo = fixture();
  const beforeManifest = readFileSync(join(repo, ".agents/manifest.yaml"), "utf8");
  assert.match(readFileSync(join(repo, "AGENTS.md"), "utf8"), /npx -y @erzhe\/harness-kit@latest deliver/);
  const first = upgrade(repo);
  assert.equal(first.status, "upgraded");
  assert.deepEqual(first.changedFiles, ["AGENTS.md", UPGRADE_STATE_REL]);
  assert.equal(readFileSync(join(repo, ".agents/manifest.yaml"), "utf8"), beforeManifest);
  assert.ok(readFileSync(join(repo, "AGENTS.md"), "utf8").includes(`npx -y ${PACKAGE}@${TARGET} deliver`));
  const state = JSON.parse(readFileSync(join(repo, UPGRADE_STATE_REL), "utf8")) as UpgradeState;
  assert.deepEqual(state, {
    schema: "ai-harness/upgrade-state/v1",
    package: PACKAGE,
    version: TARGET,
    manifestSpec: "ai-harness/v0",
    appliedMigrations: ["upgrade-state-v1"],
  });
  commit(repo, "upgrade");
  const second = upgrade(repo);
  assert.equal(second.status, "current");
  assert.deepEqual(second.changedFiles, []);
});

test("upgrade refreshes managed generated files together with durable state", () => {
  const repo = fixture();
  const managedDrift = `${readFileSync(join(repo, "AGENTS.md"), "utf8")}managed drift\n`;
  writeFileSync(join(repo, "AGENTS.md"), managedDrift);
  commit(repo, "managed drift");
  const report = upgrade(repo);
  assert.equal(report.status, "upgraded");
  assert.deepEqual(report.changedFiles, ["AGENTS.md", UPGRADE_STATE_REL]);
  assert.doesNotMatch(readFileSync(join(repo, "AGENTS.md"), "utf8"), /managed drift/);
});

test("upgrade advances the package version even when all migrations were already applied", () => {
  const repo = fixture({ lock: initialUpgradeState(PACKAGE, "0.5.0", "ai-harness/v0") });
  assert.match(readFileSync(join(repo, "AGENTS.md"), "utf8"), /npx -y @erzhe\/harness-kit@0\.5\.0 deliver/);
  const report = upgrade(repo);
  assert.equal(report.status, "upgraded");
  assert.deepEqual(report.pendingMigrations, []);
  // Entry commands are re-pinned in the same transaction as the lock.
  assert.deepEqual(report.changedFiles, ["AGENTS.md", UPGRADE_STATE_REL]);
  assert.equal((JSON.parse(readFileSync(join(repo, UPGRADE_STATE_REL), "utf8")) as UpgradeState).version, TARGET);
  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
  assert.ok(agents.includes(`npx -y ${PACKAGE}@${TARGET} deliver`));
  assert.doesNotMatch(agents, /@0\.5\.0/);
});

test("upgrade leaves repository lifecycle hook bytes untouched", () => {
  const repo = fixture();
  const hook = join(repo, ".agents/hooks/stop.sh");
  mkdirSync(join(repo, ".agents/hooks"), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\n# existing hook\n");
  commit(repo, "hook fixture");
  const report = upgrade(repo);
  assert.equal(report.status, "upgraded");
  assert.equal(report.hooksChanged, false);
  assert.equal(readFileSync(hook, "utf8"), "#!/bin/sh\n# existing hook\n");
});

test("apply refuses a dirty repository with zero upgrade writes", () => {
  const repo = fixture();
  writeFileSync(join(repo, "dirty.txt"), "dirty\n");
  const report = upgrade(repo);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.dirtyFiles, ["dirty.txt"]);
  assert.equal(existsSync(join(repo, UPGRADE_STATE_REL)), false);
});

test("invalid, foreign, and newer state all fail closed", () => {
  const invalid = fixture({ lock: "not json\n" });
  assert.match(upgrade(invalid).errors.join("\n"), /not valid JSON/);

  const foreign = fixture({ lock: initialUpgradeState("@example/other", "0.5.0", "ai-harness/v0") });
  assert.match(upgrade(foreign).errors.join("\n"), /belongs to @example\/other/);

  const newer = fixture({ lock: initialUpgradeState(PACKAGE, "9.0.0", "ai-harness/v0") });
  assert.match(upgrade(newer).errors.join("\n"), /refusing downgrade/);
});

test("upgrade refuses unmanaged generated entries and does not create state", () => {
  const repo = fixture({ agents: "# Hand-authored rules\n" });
  const report = upgrade(repo);
  assert.equal(report.status, "blocked");
  assert.match(report.errors.join("\n"), /拒绝覆盖未由 harness-kit 管理的文件: AGENTS.md/);
  assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), "# Hand-authored rules\n");
  assert.equal(existsSync(join(repo, UPGRADE_STATE_REL)), false);
});

test("an unsafe state target blocks before generated drift is written", () => {
  const repo = fixture();
  mkdirSync(join(repo, UPGRADE_STATE_REL), { recursive: true });
  writeFileSync(join(repo, UPGRADE_STATE_REL, "keep"), "keep\n");
  writeFileSync(join(repo, "AGENTS.md"), `${readFileSync(join(repo, "AGENTS.md"), "utf8")}drift\n`);
  commit(repo, "unsafe target");
  const before = readFileSync(join(repo, "AGENTS.md"), "utf8");
  const report = upgrade(repo);
  assert.equal(report.status, "blocked");
  assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), before);
});

test("CLI JSON check is one document and exits 2 when upgrade is available", () => {
  const repo = fixture();
  const result = spawnSync(TSX, [CLI, "upgrade", "--repo", repo, "--check", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout) as { schema: string; status: string };
  assert.equal(report.schema, UPGRADE_REPORT_SCHEMA);
  assert.equal(report.status, "upgrade-available");
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("CLI JSON apply includes post-upgrade doctor and verify without extra stdout", () => {
  const repo = fixture();
  const result = spawnSync(TSX, [CLI, "upgrade", "--repo", repo, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout) as {
    status: string;
    verification: { doctor: { exitCode: number }; verify: { exitCode: number; report: { schema: string } } };
  };
  assert.equal(report.status, "upgraded");
  assert.equal(report.verification.doctor.exitCode, 0);
  assert.equal(report.verification.verify.exitCode, 0);
  assert.equal(report.verification.verify.report.schema, "ai-harness/verify-report/v1");
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("CLI JSON reports incomplete verification after applying instead of losing the protocol", () => {
  const manifest = `${MANIFEST}\nknowledge:\n  - path: knowledge/missing.md\n    role: domain\n`;
  const repo = fixture({ manifest });
  const result = spawnSync(TSX, [CLI, "upgrade", "--repo", repo, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout) as {
    status: string;
    changedFiles: string[];
    verification: { doctor: { exitCode: number } };
  };
  assert.equal(report.status, "incomplete");
  assert.deepEqual(report.changedFiles, ["AGENTS.md", UPGRADE_STATE_REL]);
  assert.equal(report.verification.doctor.exitCode, 1);
  assert.equal(existsSync(join(repo, UPGRADE_STATE_REL)), true);
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("lockedHarnessVersion reads only a well-formed lock for this package", () => {
  const pinned = fixture({ lock: initialUpgradeState(PACKAGE, "0.5.1", "ai-harness/v0") });
  assert.equal(lockedHarnessVersion(pinned), "0.5.1");
  assert.equal(repoHarnessInvocation(pinned), "npx -y @erzhe/harness-kit@0.5.1");

  assert.equal(lockedHarnessVersion(fixture()), null);
  assert.equal(repoHarnessInvocation(fixture()), "npx -y @erzhe/harness-kit@latest");
  assert.equal(lockedHarnessVersion(fixture({ lock: "not json\n" })), null);
  assert.equal(lockedHarnessVersion(fixture({ lock: initialUpgradeState("@example/other", "0.5.1", "ai-harness/v0") })), null);
  // A version that is not plain semver never becomes part of a runnable command.
  const injected = fixture({ lock: initialUpgradeState(PACKAGE, "0.5.1 && curl evil", "ai-harness/v0") });
  assert.equal(lockedHarnessVersion(injected), null);
  assert.equal(harnessInvocation("0.5.1 && curl evil"), "npx -y @erzhe/harness-kit@latest");
  assert.equal(harnessInvocation("1.0.0-rc.1"), "npx -y @erzhe/harness-kit@1.0.0-rc.1");
});

test("a repository generated by 0.7.1 upgrades in place, old CLAUDE.md stub included, and hints the pinned install-hooks", () => {
  const lock = JSON.stringify({
    schema: "ai-harness/upgrade-state/v1",
    package: PACKAGE,
    version: "0.7.1",
    manifestSpec: "ai-harness/v0",
    appliedMigrations: ["upgrade-state-v1"],
  }) + "\n";
  const repo = fixture({ lock });
  const oldHeader = "<!-- GENERATED by ai-harness — DO NOT EDIT. Source of truth: .agents/manifest.yaml. Run `harness-kit sync` to regenerate. -->";
  for (const path of ["AGENTS.md", "CLAUDE.md", ".agents/reference.md"]) {
    const current = readFileSync(join(repo, path), "utf8");
    writeFileSync(join(repo, path), current.replace(/<!-- GENERATED by ai-harness — DO NOT EDIT\.[^\n]*-->/, oldHeader));
  }
  commit(repo, "as generated by 0.7.1");
  assert.match(readFileSync(join(repo, "CLAUDE.md"), "utf8"), /^@AGENTS\.md\n\n<!-- GENERATED .*Run `harness-kit sync`/);

  const result = spawnSync(TSX, [CLI, "upgrade", "--repo", repo], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(`No Harness lifecycle hooks are installed here; .*\`npx -y @erzhe/harness-kit@${TARGET.replace(/\./g, "\\.")} install-hooks --repo \\. --stop --agents <client>\``));
  assert.doesNotMatch(result.stdout, /`harness-kit install-hooks`/);
  assert.equal(readFileSync(join(repo, "CLAUDE.md"), "utf8"), new Map(renderTargets(YAML.parse(MANIFEST) as Manifest)).get("CLAUDE.md"));
});

test("upgrade refreshes existing entries but never creates the first AGENTS.md", () => {
  const repo = fixture({ generated: false });
  const report = upgrade(repo);
  assert.equal(report.status, "upgraded", report.errors.join("; "));
  assert.equal(existsSync(join(repo, "AGENTS.md")), false);
  assert.equal(existsSync(join(repo, "CLAUDE.md")), false);
  assert.ok(existsSync(join(repo, ".agents/reference.md")));
  assert.ok(report.notes.some((note) => /AGENTS\.md does not exist yet, so upgrade did not create it/.test(note)));
});

test("upgrade refreshes managed project hooks in the same transaction and keeps third-party hooks", () => {
  const lock = JSON.stringify({
    schema: "ai-harness/upgrade-state/v1",
    package: PACKAGE,
    version: "0.0.1",
    manifestSpec: "ai-harness/v0",
    appliedMigrations: ["upgrade-state-v1"],
  }) + "\n";
  const repo = fixture({ lock });
  const install = spawnSync(TSX, [CLI, "install-hooks", "--repo", repo, "--stop", "--agents", "claude"], { encoding: "utf8" });
  assert.equal(install.status, 0, install.stdout);
  // Make it look like an older release installed them: older runner pin, the 0.8.1 Stop command,
  // and a third-party hook next to ours.
  const runnerPath = join(repo, ".agents/hooks/harness-agent-hook.sh");
  const currentRunner = readFileSync(runnerPath, "utf8");
  writeFileSync(runnerPath, currentRunner.replace(/@erzhe\/harness-kit@\d+\.\d+\.\d+[^ ]*/g, "@erzhe/harness-kit@0.0.1"));
  const settingsPath = join(repo, ".claude/settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks.Stop[0].hooks[0].command =
    `bash "$(git rev-parse --show-toplevel)/.agents/hooks/harness-agent-hook.sh" claude stop || ` +
    `grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' || ` +
    `printf '%s\\n' '{"decision":"block","reason":"harness-kit hook runner is missing or failed; run the pinned deliver command from AGENTS.md manually"}'`;
  settings.hooks.Stop.unshift({ hooks: [{ type: "command", command: "echo third-party" }] });
  settings.permissions = { allow: ["Bash(ls:*)"] };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  commit(repo, "hooks from an older release");

  const check = spawnSync(TSX, [CLI, "upgrade", "--repo", repo, "--check", "--json"], { encoding: "utf8" });
  assert.equal(check.status, 2);
  const planned = JSON.parse(check.stdout);
  assert.ok(planned.changedFiles.includes(".agents/hooks/harness-agent-hook.sh"), planned.changedFiles.join(","));
  assert.ok(planned.changedFiles.includes(".claude/settings.json"));
  assert.equal(planned.hooksChanged, true);
  assert.deepEqual(planned.hooks, { agents: ["claude"], status: "refreshed" });

  const result = spawnSync(TSX, [CLI, "upgrade", "--repo", repo], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /Lifecycle hooks \(claude\): refreshed in place/);
  assert.equal(readFileSync(runnerPath, "utf8"), currentRunner);
  const refreshed = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(refreshed.permissions, { allow: ["Bash(ls:*)"] });
  const stopCommands = refreshed.hooks.Stop.flatMap((group: any) => group.hooks.map((hook: any) => hook.command));
  assert.equal(stopCommands.filter((command: string) => command === "echo third-party").length, 1);
  const ours = stopCommands.filter((command: string) => /harness-agent-hook\.sh/.test(command));
  assert.equal(ours.length, 1);
  assert.ok(ours[0].startsWith(`INPUT="$(cat)"; printf '%s' "$INPUT" | bash `), ours[0]);
  assert.match(ours[0], /\|\| \{ printf '%s' "\$INPUT" \| grep -Eq '"stop_hook_active"/);
  const doctor = spawnSync(TSX, [CLI, "doctor", "--repo", repo], { encoding: "utf8" });
  assert.doesNotMatch(doctor.stdout, /pinned to @erzhe\/harness-kit@0\.0\.1/);
});

test("upgrade drops retired context reviews along with a real upgrade, never on its own", () => {
  const lock = JSON.stringify({
    schema: "ai-harness/upgrade-state/v1",
    package: PACKAGE,
    version: "0.0.1",
    manifestSpec: "ai-harness/v0",
    appliedMigrations: ["upgrade-state-v1"],
  }) + "\n";
  const repo = fixture({ lock });
  const retired = { key: "module:gone", kind: "module", target: "gone", authority: "review", contentHash: "x", sources: {}, reason: "r", reviewedAt: "2026-11-25T00:00:00.000Z" };
  writeFileSync(join(repo, ".agents/.harness-state.json"), JSON.stringify({ bindings: {}, reviews: { "module:gone": retired } }, null, 2) + "\n");
  commit(repo, "a review of a deleted module");
  const report = upgrade(repo);
  assert.equal(report.status, "upgraded");
  assert.ok(report.changedFiles.includes(".agents/.harness-state.json"));
  assert.ok(report.notes.some((note) => /dropped retired context review record\(s\).*module:gone/.test(note)));
  assert.deepEqual(JSON.parse(readFileSync(join(repo, ".agents/.harness-state.json"), "utf8")).reviews, {});
  commit(repo, "upgraded");

  // Current version: a new retired record alone is sync's job, not an available upgrade.
  writeFileSync(join(repo, ".agents/.harness-state.json"), JSON.stringify({ bindings: {}, reviews: { "module:gone": retired } }, null, 2) + "\n");
  commit(repo, "another stale record");
  assert.equal(upgrade(repo, true).status, "current");
});

