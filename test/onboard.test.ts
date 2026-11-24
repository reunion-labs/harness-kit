import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkLoopCmd } from "../src/commands/check-loop";
import { onboardCmd } from "../src/commands/onboard";

function captureStdout(run: () => number): { code: number; out: string } {
  const orig = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = run();
  } finally {
    process.stdout.write = orig;
  }
  return { code, out: chunks.join("") };
}

test("onboard prints the skill body with a meta header and exits 0", () => {
  const { code, out } = captureStdout(onboardCmd);
  assert.equal(code, 0);
  // meta header (our instructions to the agent)
  assert.match(out, /onboarding the CURRENT repository/);
  // H13: the entry may be @latest, but every later command pins the version that printed the skill.
  const version = (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string })
    .version;
  assert.ok(out.includes(`\`npx -y @erzhe/harness-kit@${version} <cmd>\` — the exact version printing this skill`), out.slice(0, 600));
  assert.match(out, /If the repository\nalready has that lock, use the version it pins instead/);
  assert.doesNotMatch(out, /永远最新|always the latest/);
  // skill body (proves the file was found and appended)
  assert.match(out, /erzhe-harness-init/);
  assert.match(out, /\.agents\/manifest\.yaml/);
});

test("onboard preserves and classifies all legacy repository guidance", () => {
  const { out } = captureStdout(onboardCmd);
  assert.match(out, /每一份现存的 `AGENTS\.md`、`CLAUDE\.md`/);
  assert.match(out, /递归追踪.*显式引用的每一份仓内文档/);
  assert.match(out, /不以 .*文件夹名做白名单/);
  assert.match(out, /不得移动、重命名或复制既有业务文档/);
  assert.match(out, /`root: agents \| repo`/);
  assert.match(out, /`authority: derived \| policy \| review`/);
  assert.match(out, /明确过时的 `derived`.*代码、测试和本地配置证据.*原文件原地更新/);
  assert.match(out, /`policy` 文档约束代码/);
  assert.match(out, /语义歧义时，升级给用户决定/);
});

test("onboard requires lossless snapshots, a preservation ledger, and blind re-audit", () => {
  const { out } = captureStdout(onboardCmd);
  assert.match(out, /legacy entry 的 byte-preserving 快照/);
  assert.match(out, /逐规则 preservation ledger/);
  assert.match(out, /全新、独立的 agent\/context 做 blind audit/);
  assert.match(out, /不给 preservation ledger、迁移结论或预期答案/);
  assert.match(out, /发现明确缺口时.*自动修/);
  assert.match(out, /清晰缺口的修复和复审不找用户代劳/);
  assert.match(out, /语义歧义时才升级给用户/);
  assert.match(out, /普通 .*sync.*拒绝.*未接管/);
  assert.match(out, /prepare-adoption --repo \. --out <external-empty-candidate-dir>/);
  assert.match(out, /bundle.*不会写真实入口/);
  assert.match(out, /record-adoption-audit --repo \. --candidate <candidate-dir> --verdict pass/);
  assert.match(out, /sync --repo \. --adopt-existing --candidate <candidate-dir> --audit <external-receipt>/);
  assert.match(out, /assurance=declared.*independence=unverified/);
  assert.match(out, /不冒充 Agent 身份或语义判断质量/);
  assert.match(out, /没有精确 pass receipt 的裸 `--adopt-existing` 必须失败/);
});

test("onboard requires executable impact coverage without invented globs", () => {
  const { out } = captureStdout(onboardCmd);
  assert.match(
    out,
    /`modules\[\]\.owns`.*`modules\[\]\.tests`.*`modules\[\]\.checks`.*`validation\.required_coverage`/,
  );
  assert.match(out, /正向 glob 写入前都要对仓库文件清单实际求值并确认命中/);
  assert.match(out, /不得套用惯例路径、发明 glob/);
  assert.match(out, /亲自验证可运行的 capability 动词/);
  assert.match(out, /用户可观察.*验证面审计/);
  assert.match(out, /`validation\.gates`.*`modules\[\]\.gates`/);
  assert.match(out, /spec: ai-harness\/v1.*旧 CLI fail closed/);
  assert.match(out, /已有.*E2E.*不能只放在.*routing\.verify.*profile/);
  assert.match(out, /unit test.*不能满足.*acceptance/i);
  assert.match(out, /没有真实.*E2E.*不得发明/);
  assert.match(out, /invariants\[\]\.manual: true.*playbook\/pitfall/);
});

test("onboard separates analysis from sync and installs only required Agent hooks", () => {
  const { out } = captureStdout(onboardCmd);
  assert.match(out, /Agent 在分析之后/);
  assert.match(out, /record-context-review --repo \. --path <knowledge\.path> --reason/);
  assert.match(out, /record-context-review --repo \. --module <module\.name> --reason/);
  assert.match(out, /绝不能替代分析/);
  assert.match(out, /`sync`.*只根据 manifest 重生成确定性文件/);
  assert.match(out, /git rev-parse --absolute-git-dir/);
  assert.match(out, /git rev-parse --path-format=absolute --git-common-dir/);
  assert.match(out, /不能只看.*\.git.*文件.*submodule/);
  assert.match(out, /当前真正使用的客户端.*--agents/);
  assert.match(out, /harness-kit install-hooks --repo \. --stop --agents codex --allow-user-dispatcher/);
  assert.match(out, /未登记的仓库.*不执行/);
  assert.match(out, /Orca.*CODEX_HOME.*生成态运行时.*~\/\.codex/);
  assert.match(out, /不得直接补丁.*运行时.*Orca 管理脚本.*trust hash/);
  assert.match(out, /全新的 Orca Agent 会话.*evidence/);
  assert.match(out, /不让用户选择.*实现方式/);
  assert.match(out, /全新的 Agent 会话/);
  // H14: default thin mode can prove the gate; the criterion matches the evidence fields.
  assert.match(out, /`lifecycle` 记录了这个新会话的 SessionStart（`sessionStartedAt`）和最近一次 Stop（`lifecycle\.stop`）/);
  assert.match(out, /`hookActive: true`：这次 Stop 依据的门禁证据有效/);
  assert.match(out, /不需要为此切换到 execute 模式/);
  assert.match(out, /`reason: clean`）只证明 hook 被调用/);
  assert.match(out, /原生 Git hooks.*可选且仅限确认安全/);
  assert.match(out, /`required \| agent`.*立即完成/);
  assert.match(out, /`required \| human`.*明确授权/);
  assert.match(out, /首次接入.*`recommended`.*逐项判断并尽量完成/);
  assert.match(out, /install-lifecycle-hooks.*repair-lifecycle-hooks.*prove-lifecycle-hooks/);
  assert.match(out, /不要把总 GAP 数量单独抛给用户判断/);

  const installHookCommands = out
    .split("\n")
    .filter((line) => /^harness-kit install-hooks\b/.test(line));
  assert.deepEqual(installHookCommands, [
    "harness-kit install-hooks --repo . --stop --agents codex --allow-user-dispatcher",
  ]);
  const unconditionalCiInstructions = out
    .split("\n")
    .filter((line) => /\bCI\b/.test(line) && !/(?:不要|不得|禁止)/.test(line));
  assert.deepEqual(unconditionalCiInstructions, []);
});

test("check-loop prints deliver as the primary finish gate", () => {
  const { code, out } = captureStdout(checkLoopCmd);
  assert.equal(code, 0);
  assert.match(out, /harness-kit deliver/);
  assert.match(out, /accepted/);
  // A bare harness-kit is usually not on PATH: the skill points at the lock-pinned npx form.
  assert.match(out, /npx -y @erzhe\/harness-kit@<version from \.agents\/harness\.lock\.json> <cmd>/);
  assert.match(out, /npx -y @erzhe\/harness-kit@<lock 里的 version> <cmd>/);
  assert.match(out, /`not-adopted`.*退出码 3.*不要重跑/);
  assert.match(out, /inheritedContext/);
  assert.match(out, /harness-kit task-start/);
  assert.doesNotMatch(out, /task start/);
  assert.match(out, /harness-kit evidence/);
  assert.match(out, /工作区 git diff|worktree/i);
  assert.match(out, /不要求新开会话|不要.*新会话|must not demand a new session/);
  assert.match(out, /validation gate/i);
});

test("onboard audits migrated rules where they landed and settles writing-principle conflicts", () => {
  const { out } = captureStdout(onboardCmd);
  // H15: the bundle carries landing evidence; auditors need no unbound side copies.
  assert.match(out, /落点证据\*\*（`landing\/`/);
  assert.match(out, /不要另附 bundle 之外的“落点副本”/);
  assert.match(out, /逐条在 `generated\/` 或 `landing\/` 里找到落点/);
  assert.match(out, /落点 inventory\/bytes\/mode/);
  // H17: how to judge, record, and escalate conflicts with legacy writing principles.
  assert.match(out, /### 旧入口的写作原则与门禁配置冲突时/);
  assert.match(out, /只有在 `must_know`、`pitfalls`、knowledge 或生成入口里\*\*用文字复述\*\*/);
  assert.match(out, /在 ledger 里记为“改写”\*\*：写清原意.*防漂移机制/);
  assert.match(out, /告诉审计者同一判定标准/);
  assert.match(out, /何时上报负责人\*\*：.*A 接受门禁配置.*B 缩小或去掉该声明/);
});
