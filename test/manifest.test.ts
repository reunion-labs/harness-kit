import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, validateManifest } from "../src/manifest";
import type { Manifest } from "../src/manifest";

const REPO = fileURLToPath(new URL("..", import.meta.url));

test("a minimal valid manifest produces no errors", () => {
  const m: Manifest = { spec: "ai-harness/v0", identity: { name: "x", summary: "s" } };
  const errs = validateManifest(m).filter((i) => i.level === "error");
  assert.equal(errs.length, 0);
});

test("the repository impact map keeps Codex linked hooks with their focused tests", () => {
  const module = loadManifest(REPO).modules?.find((item) => item.name === "agent-hooks");
  assert.ok(module);
  assert.ok(module.owns?.includes("src/codex-linked-hooks.ts"));
  assert.ok(module.tests?.includes("test/codex-linked-hooks.test.ts"));
  assert.ok(
    module.pitfalls?.some((pitfall) =>
      /Orca.*CODEX_HOME.*生成态.*~\/\.codex.*不能补丁运行时 hooks.*trust/.test(pitfall),
    ),
  );
});

test("the repository impact map keeps shared guidance with its focused tests", () => {
  const module = loadManifest(REPO).modules?.find((item) => item.name === "core-gates");
  assert.ok(module);
  assert.ok(module.owns?.includes("src/{contracts,util,guidance}.ts"));
  assert.ok(module.tests?.includes("test/guidance.test.ts"));
});

test("the repository impact map owns project-level Codex lifecycle configuration", () => {
  const module = loadManifest(REPO).modules?.find((item) => item.name === "repository-assets");
  assert.ok(module);
  assert.ok(module.owns?.includes(".codex/**"));
});

test("the repository impact map keeps platform-neutral upgrades in one focused module", () => {
  const module = loadManifest(REPO).modules?.find((item) => item.name === "repository-upgrade");
  assert.ok(module);
  assert.deepEqual(module.entry, ["src/upgrade.ts", "src/commands/upgrade.ts"]);
  assert.deepEqual(module.owns, ["src/upgrade.ts", "src/commands/upgrade.ts", "src/harness-cli.ts"]);
  assert.deepEqual(module.tests, ["test/upgrade.test.ts"]);
  assert.ok(module.pitfalls?.some((pitfall) => /不能访问 registry、CI 或代码托管 API/.test(pitfall)));
  // 0.8.1: upgrade refreshes the project hooks Harness already manages, but never installs or removes them.
  assert.ok(module.pitfalls?.some((pitfall) => /不新装、不卸载/.test(pitfall)));

  const managed = loadManifest(REPO).modules?.find((item) => item.name === "managed-generation");
  assert.ok(managed?.tests?.includes("test/cli.test.ts"));
});

test("the repository impact map records lock-pinned commands and task-scoped delivery decisions", () => {
  const manifest = loadManifest(REPO);
  const upgrade = manifest.modules?.find((item) => item.name === "repository-upgrade");
  assert.ok(upgrade?.owns?.includes("src/harness-cli.ts"));
  assert.ok(upgrade?.pitfalls?.some((pitfall) => /只接受纯 semver/.test(pitfall)));

  const render = manifest.modules?.find((item) => item.name === "render");
  assert.ok(render?.must_know?.some((note) => /harness\.lock\.json 钉住的 npx 调用/.test(note)));

  const delivery = manifest.modules?.find((item) => item.name === "delivery");
  assert.ok(delivery?.pitfalls?.some((pitfall) => /继承的 context 过期.*独立 verify 仍严格/.test(pitfall)));
  assert.ok(delivery?.pitfalls?.some((pitfall) => /not-adopted（exit 3）/.test(pitfall)));

  const freshness = manifest.modules?.find((item) => item.name === "context-freshness");
  assert.ok(freshness?.pitfalls?.some((pitfall) => /inheritedContextKeys 拿不准就保持 task-scoped/.test(pitfall)));
});

test("the repository impact map records lifecycle proof, landing evidence, and pinned onboarding decisions", () => {
  const manifest = loadManifest(REPO);
  const module = (name: string) => manifest.modules?.find((item) => item.name === name);
  assert.ok(module("agent-hooks")?.pitfalls?.some((pitfall) => /thin 放行时绑定它接受的 deliver 戳.*不得移动 manual latest 指针/.test(pitfall)));
  assert.ok(module("validation-runner")?.pitfalls?.some((pitfall) => /hookActive \/ lifecycle 默认看最近的 lifecycle 会话/.test(pitfall)));
  assert.ok(module("managed-generation")?.pitfalls?.some((pitfall) => /candidate 必须绑定 landing 落点/.test(pitfall)));
  assert.ok(module("core-gates")?.pitfalls?.some((pitfall) => /单个 glob 零命中都要报/.test(pitfall)));
  assert.ok(module("bundled-skills")?.pitfalls?.some((pitfall) => /钉住打印它的那个版本/.test(pitfall)));
});

test("the repository impact map records the 0.7.2 rollout decisions", () => {
  const manifest = loadManifest(REPO);
  const module = (name: string) => manifest.modules?.find((item) => item.name === name);
  assert.ok(module("managed-generation")?.pitfalls?.some((pitfall) => /纯路径提及降级为 unresolved.*仍 fail closed/.test(pitfall)));
  assert.ok(module("managed-generation")?.pitfalls?.some((pitfall) => /isHarnessGenerated/.test(pitfall)));
  assert.ok(module("managed-generation")?.pitfalls?.some((pitfall) => /没有 legacy 入口也一样/.test(pitfall)));
  assert.ok(module("validation-runner")?.pitfalls?.some((pitfall) => /SessionStart 新建会话不得移动 manual latest 指针/.test(pitfall)));
  assert.ok(module("delivery")?.pitfalls?.some((pitfall) => /stamp 按 target 读取/.test(pitfall)));
  assert.ok(module("agent-hooks")?.pitfalls?.some((pitfall) => /LEGACY_HOOK_FAILURE_MESSAGES/.test(pitfall)));
});

test("the repository impact map records the 0.8.0 rollout decisions", () => {
  const manifest = loadManifest(REPO);
  const module = (name: string) => manifest.modules?.find((item) => item.name === name);
  assert.ok(module("agent-hooks")?.pitfalls?.some((pitfall) => /CLI 不可用时干净工作区放行.*绝不无限拦截/.test(pitfall)));
  assert.ok(module("agent-hooks")?.pitfalls?.some((pitfall) => /loop-exit/.test(pitfall)));
  assert.ok(module("managed-generation")?.pitfalls?.some((pitfall) => /普通 sync 不创建首个 AGENTS\.md/.test(pitfall)));
  assert.ok(module("managed-generation")?.pitfalls?.some((pitfall) => /worktree 证据/.test(pitfall)));
  assert.ok(module("planner")?.pitfalls?.some((pitfall) => /HARNESS_COVERED_GLOBS/.test(pitfall)));
  assert.ok(module("render")?.pitfalls?.some((pitfall) => /词数预算只算仓库内容/.test(pitfall)));
  assert.ok(module("repository-upgrade")?.pitfalls?.some((pitfall) => /不创建首个 AGENTS\.md/.test(pitfall)));
});

test("the repository impact map records the 0.8.1 upgrade-round decisions", () => {
  const manifest = loadManifest(REPO);
  const module = (name: string) => manifest.modules?.find((item) => item.name === name);
  assert.ok(module("render")?.pitfalls?.some((pitfall) => /汉字 \/ 假名每个算半个词/.test(pitfall)));
  assert.ok(module("planner")?.pitfalls?.some((pitfall) => /capability 的 run 命令引用/.test(pitfall)));
  assert.ok(module("agent-hooks")?.pitfalls?.some((pitfall) => /兜底的 stop_hook_active 守卫读这份副本/.test(pitfall)));
  assert.ok(module("agent-hooks")?.pitfalls?.some((pitfall) => /rebind/.test(pitfall)));
  assert.ok(module("repository-upgrade")?.pitfalls?.some((pitfall) => /原位刷新已由 Harness 管理的项目级 hook/.test(pitfall)));
  assert.ok(module("managed-generation")?.pitfalls?.some((pitfall) => /retired review/.test(pitfall)));
});

test("the repository impact map records the 0.8.2 decisions", () => {
  const manifest = loadManifest(REPO);
  const module = (name: string) => manifest.modules?.find((item) => item.name === name);
  assert.ok(module("agent-hooks")?.pitfalls?.some((pitfall) => /先把 stdin 读进变量再交给 runner.*放行时同样提示未验证/.test(pitfall)));
  assert.ok(module("agent-hooks")?.pitfalls?.some((pitfall) => /HARNESS_KIT_CMD override 放在 runner 调用之前/.test(pitfall)));
  const upgradeRoute = manifest.routing?.find((route) => route.when.startsWith("改 Harness 版本升级规则"));
  assert.ok(upgradeRoute?.dont_assume?.some((rule) => /已装的项目级 Hook 也在其中原位刷新/.test(rule)));
  assert.ok(!upgradeRoute?.dont_assume?.some((rule) => /必须留给 install-hooks 显式处理/.test(rule)));
});

test("SPEC states the exact declarative enforcement scan semantics", () => {
  const spec = readFileSync(join(REPO, "SPEC-v0.md"), "utf8");
  assert.match(spec, /`forbid_pattern` \/ `forbid_import` 是不带 flag 的 JavaScript `RegExp`，对每个文件\*\*逐行\*\*/);
  assert.match(spec, /`path_glob` 由 fast-glob 在 target 根下求值（只取文件，`dot: false`）/);
  assert.match(spec, /只有\*\*纯路径提及\*\*在所有基准下都找不到仓内文件时，才记成 candidate 的 `unresolved` 条目/);
});

test("an unknown manifest spec is rejected instead of being interpreted as v0", () => {
  const m: Manifest = { spec: "ai-harness/v999", identity: { name: "x", summary: "s" } };
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /不支持.*ai-harness\/v999.*ai-harness\/v0/.test(message)));
});

test("validation gates require v1 so older CLIs reject them instead of silently running unit-only", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "legacy", summary: "legacy spec" },
    capabilities: { e2e: { run: "pnpm e2e" } },
    modules: [{ name: "ui", role: "ui", entry: ["src/ui.ts"], owns: ["src/**"], gates: ["flow"] }],
    validation: { gates: { flow: { checks: ["e2e"] } } },
  } as unknown as Manifest;

  const errors = validateManifest(m).filter((issue) => issue.level === "error").map((issue) => issue.msg);
  assert.ok(errors.some((message) => /需要 spec: ai-harness\/v1.*旧版 CLI fail closed/.test(message)));
});

test("contract ids are restricted to portable filename characters", () => {
  const m: Manifest = {
    spec: "ai-harness/v1",
    identity: { name: "x", summary: "s" },
    contracts: [
      { id: "../../../escape", kind: "api", desc: "escape" },
      { id: ".hidden", kind: "api", desc: "hidden" },
      { id: "has space", kind: "api", desc: "space" },
      { id: "safe.v1_contract-2", kind: "api", desc: "safe" },
      { id: "CON.api", kind: "api", desc: "Windows device name" },
    ],
  };
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.equal(errors.filter((message) => /contracts\[\d+\]\.id 必须是可移植文件名/.test(message)).length, 4);
  assert.ok(!errors.some((message) => /contracts\[3\]\.id/.test(message)));
});

test("contract ids are unique after ASCII case-folding", () => {
  const m: Manifest = {
    spec: "ai-harness/v1",
    identity: { name: "x", summary: "s" },
    contracts: [
      { id: "API", kind: "api", desc: "upper" },
      { id: "api", kind: "api", desc: "lower" },
    ],
  };
  const errors = validateManifest(m).filter((issue) => issue.level === "error").map((issue) => issue.msg);
  assert.ok(errors.some((message) => /大小写不敏感文件系统上重复: api/.test(message)));
});

test("knowledge root and authority accept repo documents without constraining directory names", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    knowledge: [
      { path: "engineering/tribal-notes/api.md", root: "repo", authority: "derived", binds: ["src/api.ts"] },
      { path: "knowledge/policy.md", root: "agents", authority: "policy", binds: ["src/auth.ts"] },
      { path: "README.md", root: "repo", authority: "review" },
    ],
  };
  assert.deepEqual(
    validateManifest(m).filter((issue) => issue.level === "error"),
    [],
  );
});

test("knowledge paths stay inside their declared root and remain unambiguous for review", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    knowledge: [
      { root: "repo", path: "../outside.md", binds: ["/tmp/source.ts"] },
      { root: "agents", path: "same.md" },
      { root: "repo", path: "same.md" },
    ],
    modules: [{ name: "escape", role: "invalid", entry: ["../outside.ts"] }],
  };
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /knowledge.*path.*相对路径|knowledge.*path.*越界/.test(message)));
  assert.ok(errors.some((message) => /binds.*相对路径|binds.*越界/.test(message)));
  assert.ok(errors.some((message) => /knowledge path 重复.*same\.md/.test(message)));
  assert.ok(errors.some((message) => /module.*entry.*相对路径|module.*entry.*越界/.test(message)));
});

test("knowledge root, authority, and invariant allow_empty are type checked", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    knowledge: [{ path: "README.md", root: "somewhere", authority: "truthy" }],
    invariants: [{ id: "absence", rule: "file stays absent", enforcement: { forbid_pattern: ["bad"], allow_empty: "yes" } }],
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /knowledge.*root.*agents\/repo/.test(message)));
  assert.ok(errors.some((message) => /knowledge.*authority.*derived\/policy\/review/.test(message)));
  assert.ok(errors.some((message) => /allow_empty.*布尔值/.test(message)));
});

test("negated globs fail with an actionable positive-glob diagnostic", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    invariants: [{ id: "safe", rule: "safe", enforcement: { forbid_pattern: ["bad"], path_glob: ["src/**", "!src/test/**"] } }],
    modules: [{ name: "core", role: "core", entry: ["src/index.ts"], owns: ["!src/generated/**"] }],
    validation: { required_coverage: ["!test/**"] },
  };
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.equal(errors.filter((message) => /不支持 ! 否定 glob/.test(message)).length, 3);
});

test("oversized path_glob is rejected during manifest validation before matcher execution", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    invariants: [
      { id: "oversized", rule: "must not reach fast-glob", enforcement: { forbid_pattern: ["bad"], path_glob: ["a".repeat(70_000)] } },
    ],
  };
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /path_glob\[0\].*过长.*4096.*安全编译/.test(message)));
});

test("missing spec and identity.name are reported as errors", () => {
  const m = { identity: {} } as unknown as Manifest;
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /spec/.test(e)));
  assert.ok(errs.some((e) => /identity\.name/.test(e)));
});

test("duplicate invariant id is an error", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    invariants: [
      { id: "dup", rule: "r1", manual: true },
      { id: "dup", rule: "r2", manual: true },
    ],
  };
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /重复: dup/.test(e)));
});

test("routing verify referencing an unknown capability warns", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    routing: [{ when: "fix", verify: ["nonexistent"] }],
  };
  const warns = validateManifest(m)
    .filter((i) => i.level === "warn")
    .map((i) => i.msg);
  assert.ok(warns.some((w) => /未声明的 capability/.test(w)));
});

test("module.checks must reference a declared capability (error)", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    capabilities: { test: { run: "t" } },
    modules: [{ name: "a", role: "r", entry: ["src/a.ts"], checks: ["test", "ghost"] }],
  };
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /ghost/.test(e) && /capability/.test(e)));
});

test("validation checksets/defaults must reference declared capabilities (error)", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    capabilities: { test: { run: "t" } },
    validation: {
      checksets: { ui: { checks: ["test", "phantom"] } },
      defaults: { no_match: ["nope"], always: ["test"] },
    },
  };
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /phantom/.test(e)));
  assert.ok(errs.some((e) => /nope/.test(e)));
});

test("a validation checkset must declare its checks array", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    validation: { checksets: { full: {} } },
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /checksets\.full\.checks.*必填/.test(message)));
});

test("a non-array where an array is expected is an error (Array.isArray guard)", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    modules: [{ name: "a", role: "r", entry: ["src/a.ts"], owns: "src/**" }],
  } as unknown as Manifest;
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /owns/.test(e) && /数组/.test(e)));
});

test("a non-object manifest root is rejected without throwing", () => {
  const errs = validateManifest(null as unknown as Manifest).filter((issue) => issue.level === "error");
  assert.match(errs[0]?.msg ?? "", /根节点/);
});

test("test-touch policy and required coverage shapes are validated", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x" },
    modules: [{ name: "a", role: "r", entry: ["src/a.ts"], test_touch: "sometimes" }],
    validation: { policies: { test_touch_default: "always" }, required_coverage: "src/**" },
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /test_touch/.test(message)));
  assert.ok(errors.some((message) => /required_coverage/.test(message)));
});

test("numeric routing.verify and module.checks report schema errors instead of throwing", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x" },
    routing: [{ when: "fix", verify: 1 }],
    modules: [{ name: "a", role: "r", entry: ["src/a.ts"], checks: 1 }],
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /routing.*verify/.test(message)));
  assert.ok(errors.some((message) => /module.*checks/.test(message)));
});

test("invariant execution controls reject quoted booleans and ambiguous manual checks", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    invariants: [
      { id: "quoted", rule: "must run", manual: "false", enforcement: { forbid_pattern: ["bad"] } },
      { id: "ambiguous", rule: "choose one mode", manual: true, check: "true" },
    ],
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /quoted\.manual.*布尔值/.test(message)));
  assert.ok(errors.some((message) => /ambiguous.*同时声明/.test(message)));
});

test("invalid invariant regular expressions are rejected before verify executes them", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    invariants: [{ id: "broken-rx", rule: "must compile", enforcement: { forbid_pattern: ["["] } }],
  };
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /broken-rx.*forbid_pattern.*正则/.test(message)));
});

test("module.name must be a non-empty string", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    modules: [{ name: 42, role: "r", entry: ["src/a.ts"] }],
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /module\.name.*字符串/.test(message)));
});

test("project-defined validation gates bind runnable checks and isolated acceptance tests to modules", () => {
  const m = {
    spec: "ai-harness/v1",
    identity: { name: "desktop", summary: "desktop app" },
    capabilities: {
      unit: { run: "pnpm test:unit" },
      "desktop-e2e": { run: "pnpm test:e2e" },
    },
    modules: [
      {
        name: "renderer",
        role: "renderer UI",
        entry: ["src/renderer.ts"],
        owns: ["src/renderer/**"],
        tests: ["test/unit/**"],
        checks: ["unit"],
        gates: ["desktop-user-flow"],
      },
    ],
    validation: {
      gates: {
        "desktop-user-flow": {
          desc: "exercise the real desktop boundary",
          checks: ["desktop-e2e"],
          acceptance: { tests: ["e2e/desktop/**"], test_touch: "required" },
        },
      },
    },
  } as unknown as Manifest;

  assert.deepEqual(
    validateManifest(m).filter((issue) => issue.level === "error"),
    [],
  );
});

test("validation gates fail closed on unknown refs, unsafe checks, and incomplete acceptance policy", () => {
  const m = {
    spec: "ai-harness/v1",
    identity: { name: "desktop", summary: "desktop app" },
    capabilities: {
      unit: { run: "pnpm test:unit" },
      daemon: { run: "pnpm dev", background: true },
    },
    modules: [
      {
        name: "renderer",
        role: "renderer UI",
        entry: ["src/renderer.ts"],
        owns: ["src/renderer/**"],
        gates: ["missing-gate", "broken-gate"],
      },
    ],
    validation: {
      gates: {
        "broken-gate": {
          checks: ["ghost", "daemon"],
          acceptance: { tests: ["!e2e/generated/**"], test_touch: "sometimes" },
        },
        "empty-gate": { checks: [] },
      },
    },
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);

  assert.ok(errors.some((message) => /validation gate missing-gate 未声明/.test(message)));
  assert.ok(errors.some((message) => /broken-gate\.checks 引用了未声明的 capability: ghost/.test(message)));
  assert.ok(errors.some((message) => /broken-gate\.checks 引用了不可自动执行的 capability: daemon/.test(message)));
  assert.ok(errors.some((message) => /broken-gate.*acceptance.*不支持 !/.test(message)));
  assert.ok(errors.some((message) => /broken-gate.*test_touch.*required\/advisory\/off/.test(message)));
  assert.ok(errors.some((message) => /empty-gate.*checks.*至少一个/.test(message)));
});

test("validation gates cannot be dead configuration", () => {
  const m = {
    spec: "ai-harness/v1",
    identity: { name: "desktop", summary: "desktop app" },
    capabilities: { e2e: { run: "pnpm e2e" } },
    modules: [{ name: "renderer", role: "renderer", entry: ["src/page.ts"], gates: ["linked"] }],
    validation: {
      gates: {
        linked: { checks: ["e2e"] },
        "orphan-check-only": { checks: ["e2e"] },
        orphan: { checks: ["e2e"], acceptance: { tests: ["e2e/**"], test_touch: "required" } },
      },
    },
  } as unknown as Manifest;
  const errors = validateManifest(m).filter((issue) => issue.level === "error").map((issue) => issue.msg);

  assert.ok(errors.some((message) => /module "renderer".*gates.*没有 owns/.test(message)));
  assert.ok(errors.some((message) => /validation gate orphan-check-only 未被任何 module\.gates 引用/.test(message)));
  assert.ok(errors.some((message) => /validation gate orphan 未被任何 module\.gates 引用/.test(message)));
});

