import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doctorCmd } from "../src/commands/doctor";
import { syncCmd } from "../src/commands/sync";
import { loadManifest } from "../src/manifest";
import { recordContextReview } from "../src/state";

function write(repo: string, rel: string, content: string): void {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function capture(fn: () => number): { code: number; output: string } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    return { code: fn(), output: chunks.join("") };
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
  }
}

test("doctor accepts arbitrary repo-root knowledge, routing globs, and intentional empty enforcement", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-v03-"));
  write(repo, "src/api/route.ts", "export const route = '/v1';\n");
  write(repo, "engineering/handbook/api.md", "API notes.\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: doctor-v03, summary: doctor fixture }
knowledge:
  - { root: repo, path: engineering/handbook/api.md, role: api }
routing:
  - { when: change-api, read: ['src/api/**/*.ts'], entry: ['src/api/*.ts'] }
invariants:
  - id: intentionally-absent
    rule: removed workspace stays removed
    enforcement:
      path_glob: [pnpm-workspace.yaml]
      forbid_pattern: [packages]
      allow_empty: true
`,
  );
  syncCmd(repo, { createEntry: true });
  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /knowledge: engineering\/handbook\/api\.md/);
  assert.doesNotMatch(result.output, /passes without checking anything/);
  assert.match(result.output, /Agent lifecycle hooks[\s\S]*DEGRADED/);
  assert.match(result.output, /NEXT ACTIONS[\s\S]*nothing required now/);
  assert.match(result.output, /recommended maintenance action/);
  assert.match(result.output, /doctor: repository configuration healthy/);
  assert.match(result.output, /Harness readiness: READY/);
});

test("doctor keeps informational boundaries compact and expands maintenance work on request", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-guidance-"));
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: doctor-guidance, summary: doctor guidance fixture }
invariants:
  - { id: manual-policy, rule: "review policy", manual: true }
  - { id: missing-gate, rule: "enforce policy" }
`,
  );
  syncCmd(repo, { createEntry: true });

  const compact = capture(() => doctorCmd(repo));
  assert.equal(compact.code, 0, compact.output);
  assert.match(compact.output, /2 declared: 1 automation improvement\(s\), 1 check\(s\) only when relevant/);
  assert.doesNotMatch(compact.output, /Add enforcement for invariant missing-gate/);

  const detailed = capture(() => doctorCmd(repo, { details: true }));
  assert.equal(detailed.code, 0, detailed.output);
  assert.match(detailed.output, /\[RECOMMENDED\] Add enforcement for invariant missing-gate/);
  assert.match(detailed.output, /\[INFORMATIONAL\] Review invariant manual-policy when relevant/);
  assert.match(detailed.output, /\[RECOMMENDED \| AGENT\] Improve 1 verification declaration\(s\)/);
});

test("explicit authority is blocking until record-context-review is recorded", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-context-"));
  write(repo, "src/api.ts", "export const route = '/v1';\n");
  write(repo, "engineering/api.md", "API notes.\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: doctor-context, summary: context fixture }
knowledge:
  - root: repo
    path: engineering/api.md
    role: api
    authority: derived
    binds: [src/api.ts]
`,
  );
  syncCmd(repo, { createEntry: true });
  const before = capture(() => doctorCmd(repo));
  assert.equal(before.code, 1);
  assert.match(before.output, /尚未记录复核/);

  const manifest = loadManifest(repo);
  recordContextReview(repo, manifest, { path: "engineering/api.md", reason: "compared against current route implementation" });
  const after = capture(() => doctorCmd(repo));
  assert.equal(after.code, 0, after.output);
});

test("a routing glob that matches nothing is an actionable doctor error", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-route-"));
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: doctor-route, summary: route fixture }
routing:
  - { when: missing, read: ['nowhere/**/*.ts'] }
`,
  );
  syncCmd(repo, { createEntry: true });
  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 1);
  assert.match(result.output, /routing.*glob.*0 paths/);
});

test("doctor treats only the semantic CLAUDE.md -> AGENTS.md alias as in sync", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-alias-"));
  write(repo, ".agents/manifest.yaml", "spec: ai-harness/v0\nidentity: { name: alias, summary: alias fixture }\n");
  symlinkSync("AGENTS.md", join(repo, "CLAUDE.md"));
  syncCmd(repo, { createEntry: true });

  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /CLAUDE\.md.*semantic alias|CLAUDE\.md in sync/);
});

test("doctor blocks a required validation gate whose acceptance glob matches no tests", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-gate-"));
  write(repo, "src/renderer/page.ts", "export const page = 1;\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v1
identity: { name: doctor-gate, summary: validation gate fixture }
capabilities:
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer UI
    entry: [src/renderer/page.ts]
    owns: [src/renderer/**]
    gates: [user-flow]
validation:
  gates:
    user-flow:
      checks: [e2e]
      acceptance:
        tests: [e2e/**]
        test_touch: required
`,
  );
  syncCmd(repo, { createEntry: true });

  const missing = capture(() => doctorCmd(repo));
  assert.equal(missing.code, 1);
  assert.match(missing.output, /validation gate user-flow.*acceptance.*0 files.*required/i);

  write(repo, "e2e/user-flow.spec.ts", "// acceptance coverage\n");
  const covered = capture(() => doctorCmd(repo));
  assert.equal(covered.code, 0, covered.output);
});

test("doctor does not accept validation coverage reached through a symlink outside the repository", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-gate-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "hk-doctor-gate-outside-"));
  write(repo, "src/renderer/page.ts", "export const page = 1;\n");
  write(outside, "flow.spec.ts", "// outside acceptance coverage\n");
  symlinkSync(outside, join(repo, "e2e"), "dir");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v1
identity: { name: symlink-gate, summary: validation gate symlink fixture }
capabilities:
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer UI
    entry: [src/renderer/page.ts]
    owns: [src/renderer/**]
    gates: [user-flow]
validation:
  gates:
    user-flow:
      checks: [e2e]
      acceptance:
        tests: [e2e/**]
        test_touch: required
`,
  );
  syncCmd(repo, { createEntry: true });

  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 1);
  assert.match(result.output, /validation gate user-flow.*acceptance.*0 files.*required/i);
});

test("doctor does not let an in-repository symlink alias bypass gate boundary overlap", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-gate-alias-"));
  write(repo, "src/renderer/page.ts", "export const page = 1;\n");
  write(repo, "test/flow.spec.ts", "// unit coverage cannot double as gate acceptance\n");
  symlinkSync(join(repo, "test"), join(repo, "e2e"), "dir");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v1
identity: { name: alias-gate, summary: validation gate symlink alias fixture }
capabilities:
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer UI
    entry: [src/renderer/page.ts]
    owns: [src/renderer/**]
    tests: [test/**]
    gates: [user-flow]
validation:
  gates:
    user-flow:
      checks: [e2e]
      acceptance:
        tests: [e2e/**]
        test_touch: required
`,
  );
  syncCmd(repo, { createEntry: true });

  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 1);
  assert.match(result.output, /validation gate user-flow.*acceptance.*0 files.*required/i);
});

test("doctor blocks a check-only gate whose module owns no real files", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-gate-dead-owns-"));
  write(repo, "src/page.ts", "export const page = 1;\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v1
identity: { name: dead-owns-gate, summary: check-only gate fixture }
capabilities:
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer UI
    entry: [src/page.ts]
    owns: [src/renderer/**]
    gates: [user-flow]
validation:
  gates:
    user-flow:
      checks: [e2e]
`,
  );
  syncCmd(repo, { createEntry: true });

  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 1);
  assert.match(result.output, /validation gate user-flow.*module renderer owns matches 0 files.*cannot activate this gate/i);
});

test("doctor blocks required acceptance files that overlap module unit or production boundaries", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-gate-overlap-"));
  write(repo, "src/page.ts", "export const page = 1;\n");
  write(repo, "test/page.test.ts", "// unit\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v1
identity: { name: overlap, summary: overlap fixture }
capabilities:
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer
    entry: [src/page.ts]
    owns: [src/**]
    tests: [test/**]
    gates: [flow]
validation:
  gates:
    flow:
      checks: [e2e]
      acceptance:
        tests: [test/**]
        test_touch: required
`,
  );
  syncCmd(repo, { createEntry: true });

  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 1);
  assert.match(result.output, /validation gate flow.*overlap module renderer owns\/tests.*unit or production files cannot satisfy/i);
});

test("doctor reports every dead owns or tests glob, not only a fully dead module", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-glob-rot-"));
  write(repo, "src/api/handler.go", "package api\n");
  write(repo, "src/api/handler_test.go", "package api\n");
  write(repo, ".github/workflows/ci.yml", "on: push\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: glob-rot, summary: per-glob doctor fixture }
modules:
  - name: api
    role: http api
    entry: [src/api/handler.go]
    owns: ["src/api/**", "src/legacy/**", ".github/**"]
    tests: ["src/api/*_test.go", "test/api/**"]
  - name: ghost
    role: removed module
    entry: [src/api/handler.go]
    owns: ["src/ghost/**"]
`,
  );
  syncCmd(repo, { createEntry: true });
  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /WARN module api: owns glob "src\/legacy\/\*\*" matches 0 files — changes under it can never select this module/);
  assert.match(result.output, /WARN module api: tests glob "test\/api\/\*\*" matches 0 files — it can never map a test change or satisfy test_touch/);
  // Dot directories match the way the planner matches them.
  assert.doesNotMatch(result.output, /"\.github\/\*\*" matches 0/);
  assert.doesNotMatch(result.output, /"src\/api\/\*\*" matches 0|"src\/api\/\*_test\.go" matches 0/);
  // A module with no live owns at all keeps the stronger whole-module warning.
  assert.match(result.output, /WARN module ghost: owns glob matches 0 files — impact planner can never select it/);
  assert.doesNotMatch(result.output, /module ghost: owns glob "src\/ghost/);
});

test("doctor's AGENTS.md budget counts repository content and says the fixed text is excluded", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-budget-"));
  const rules = Array.from({ length: 40 }, (_, index) => `  - id: rule-${index}\n    rule: 规则 ${index}：每条 rule 都有 several English words to pad the text\n    manual: true`);
  write(repo, ".agents/manifest.yaml", `spec: ai-harness/v0\nidentity: { name: budget, summary: budget fixture }\ninvariants:\n${rules.join("\n")}\n`);
  syncCmd(repo, { createEntry: true });
  const result = capture(() => doctorCmd(repo));
  assert.match(result.output, /AGENTS\.md \d+ lines \/ \d+ words; repository content \d+ words \(budget 150 lines \/ 500 content words; fixed Harness text not counted; a Han \/ Kana character is half a word\)/);
  assert.match(result.output, /WARN .*repository content \d+ words.*Move detail into \.agents\/knowledge\//);
  assert.match(result.output, /largest sections \(words\): Invariants \(must hold\) \d+, .*this is advisory maintenance, not an upgrade step/);
});

test("doctor pairs a context-freshness ERR with the required review command", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-next-"));
  write(repo, "src/api.ts", "export const route = '/v1';\n");
  write(
    repo,
    ".agents/manifest.yaml",
    "spec: ai-harness/v0\nidentity: { name: next, summary: doctor next action }\nmodules:\n  - name: workflow\n    role: r\n    entry: [src/api.ts]\n",
  );
  syncCmd(repo, { createEntry: true });
  recordContextReview(repo, loadManifest(repo), { module: "workflow", reason: "checked" });
  write(
    repo,
    ".agents/manifest.yaml",
    "spec: ai-harness/v0\nidentity: { name: next, summary: doctor next action }\nmodules:\n  - name: workflow\n    role: r\n    entry: [src/api.ts]\n    upstream: [a, b]\n",
  );
  syncCmd(repo);
  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 1);
  assert.match(result.output, /ERR  module:workflow/);
  assert.match(result.output, /\[REQUIRED \| AGENT\] Re-review 1 stale context item\(s\)/);
  assert.match(result.output, /run: .*record-context-review --repo \. --module workflow --reason/);
  assert.doesNotMatch(result.output, /nothing required now/);
});

test("doctor points at hand-written Harness commands that upgrade cannot rewrite", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-pins-"));
  write(repo, ".agents/harness.lock.json", JSON.stringify({ schema: "ai-harness/upgrade-state/v1", package: "@erzhe/harness-kit", version: "0.8.1", manifestSpec: "ai-harness/v0", appliedMigrations: ["upgrade-state-v1"] }) + "\n");
  write(
    repo,
    ".agents/manifest.yaml",
    "spec: ai-harness/v0\nidentity: { name: pins, summary: pins }\nrouting:\n  - when: any change\n    read: [.agents]\n    verify: ['npx -y @erzhe/harness-kit@0.7.2 deliver']\n",
  );
  write(
    repo,
    ".agents/adoption.md",
    "# Tooling adoption log\n\nand only promote a convention to a machine check (`harness-kit verify`) after it actually bites.\n\n" +
      "## Log\n- 2026-11-25 ran `npx -y @erzhe/harness-kit@0.7.2 evidence` after the upgrade\n\n## Preservation ledger\n- kept `@erzhe/harness-kit@0.6.0` wording\n",
  );
  write(repo, ".agents/knowledge/conventions.md", "Run `npx -y @erzhe/harness-kit@0.8.1 deliver` before finishing.\n");
  write(repo, ".agents/knowledge/journal/0001.md", "Written for npx -y @erzhe/harness-kit@0.6.0.\n");
  syncCmd(repo, { createEntry: true });
  const result = capture(() => doctorCmd(repo));
  assert.match(result.output, /WARN \.agents\/manifest\.yaml:\d+ pins @erzhe\/harness-kit@0\.7\.2; the lock pins 0\.8\.1/);
  assert.match(result.output, /WARN \.agents\/adoption\.md:3 names a bare `harness-kit verify`/);
  assert.doesNotMatch(result.output, /conventions\.md/);
  assert.doesNotMatch(result.output, /journal\/0001\.md/, "journal ADRs are history");
  assert.doesNotMatch(result.output, /adoption\.md:(6|9) /, "the adoption Log and the records after it are history");
});
