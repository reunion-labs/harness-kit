# @erzhe/harness-kit

> 给 Agent 发一句话，让它帮你把仓库变成 AI 友好的。

harness-kit 把仓库的工程知识（这是什么、怎么跑、什么不能破、改东西看哪）沉淀成一份 `.agents/manifest.yaml`，然后自动生成各家 Agent 的入口文件（`AGENTS.md` / `CLAUDE.md`），并用门禁保证它们始终一致。

---

## 最快上手

在**任意仓库**里，把这句话丢给你的 Agent（Cursor / Claude Code / Codex 通用）：

```
Onboard 本仓库到 harness-kit：跑 npx -y @erzhe/harness-kit@latest onboard，然后严格按输出执行。
```

入口用 `@latest` 拿到最新版；它打印的流程会把之后每条命令钉到这个具体版本（例如 `npx -y @erzhe/harness-kit@0.7.2`），`init` 再把版本写进 `.agents/harness.lock.json`。此后所有命令都按 lock 钉住的版本调用。

就这一句。Agent 会：

1. 拉取最新版的 onboard skill
2. 扫描你的仓库（读 README、package.json、目录结构…）
3. 盘点已有 `AGENTS.md` / `CLAUDE.md` 及其明确引用的业务文档；原文留在原位置，不按文件夹名搬家
4. 先保存逐字节 legacy 快照，再由另一个 Agent 盲审规则是否完整；明确缺口自动修复并复审，只有语义歧义才找人确认
5. 跑 `sync` / `doctor` / `verify`，补齐真实的 `owns / tests / checks` 影响面；已有浏览器或 Electron E2E 时，把用户可见高风险模块接到不可被 profile 绕过的 validation gate
6. 自动识别当前客户端和 Git worktree 形态，安装真正会生效的 Agent SessionStart + Stop 门禁，并用一个新会话留下真实 evidence；原生 Git hooks 只在作用域可证明安全时按需安装

全程走 `npx`，不全局安装 npm 包；你一发新版，所有人下次执行就用上了。唯一的用户级文件例外是 Codex linked-worktree 的显式安全分发器（见下文），因为当前 Codex 在不同启动环境里可能忽略项目 Hook，也可能与用户 Hook 同时执行。

已有仓库升级不需要重新 `init` / `onboard`，也不需要把 Harness 加进业务依赖：

```bash
npx -y @erzhe/harness-kit@latest upgrade --repo . --check
npx -y @erzhe/harness-kit@latest upgrade --repo .
```

`upgrade` 的目标版本就是你运行的 CLI 版本：用 `@latest` 跟进最新版，或换成 `@<具体版本>` 精确控制。升级后 `.agents/harness.lock.json` 记录新版本，生成的 `AGENTS.md` 里所有 Harness 命令也随之钉到这个版本。

`--check` 完全只读：已是当前版本返回 0，需要升级返回 2，阻塞或状态损坏返回 1。正式 apply 要求目标 Git scope 干净，并把 manifest（仅在迁移确实改变时）、全部生成入口和 `.agents/harness.lock.json` 放进同一仓内文件事务。版本获取由调用方决定，所以公共 npm、公司内部镜像、本地固定二进制都能使用同一接口。0.5.1 不在 `upgrade` 里改 Hook；Hook 仍通过 `install-hooks` 单独管理。

`--json` 始终只输出一份 `ai-harness/upgrade-report/v1`，包含 `status`、from/to version、pending/applied migrations、changed/dirty files、errors 和 post-upgrade verification。状态文件同样是确定性协议：`ai-harness/upgrade-state/v1` 只保存 package、version、manifest spec 与已应用 migration IDs；它应随代码提交，没有时间戳，也没有“使用哪些 Agent”的名单。

运行要求：Node.js 18 或更高版本。发布前会用打包后的 CLI 在真实 Node 18 上做 `help / doctor / verify` smoke。

### 发版（维护者）

合入 `main` 不会发包。发版只需两步：

1. 在 PR 里修改 `package.json` 的 `version`，然后合入 `main`。
2. 推送同名 tag：`git tag v<version> && git push origin v<version>`。

推送 tag 后，`.github/workflows/publish.yml` 会自动完成以下检查和发布，任一步失败都不会发包：

- tag 必须与 `package.json` 版本一致，且该版本尚未发布到 npm
- 打包后的 CLI 在 Node 18 上跑 `help / doctor / verify` smoke
- typecheck、test、build
- 以 npm Trusted Publishing（OIDC，带 provenance）发布：版本号含 `-` 时发布到 `next`，否则发布到 `latest`
- 创建 GitHub Release

发布不需要 npm token，但工作流文件名和仓库路径已登记在 npm 包设置里。改工作流文件名或迁移仓库前，要先在 npm 包设置中更新 Trusted Publisher。

---

## 初始化后你得到什么

```
你的仓库/
  AGENTS.md                    ← [生成] 跨工具入口，Agent 每次会话必读
  CLAUDE.md                    ← [生成] Claude Code 入口
  .agents/
    manifest.yaml              ← 你维护的唯一真相源
    knowledge/                 ← Harness 自己新增的知识（不强迫搬入已有业务文档）
    reference.md               ← [生成] 完整命令、环境、原位置知识路径目录
    contracts/                 ← 对外接口的契约基线
    adoption/legacy/           ← 首次接管前的逐字节入口文件快照
    playbooks/                 ← 可复用的工作流（SKILL.md）
    routing.md                 ← [生成] 按改动类型导航：改 UI 看哪、加接口看哪
    modules.md                 ← [生成] 模块卡：每个子系统的职责/入口/坑
```

以后改工程结构 → 编辑 `manifest.yaml` → `harness-kit sync`。Harness Kit 发新版后，用新版 CLI 运行 `harness-kit upgrade` 做原地迁移；它只修改仓库内 Harness 状态，不依赖 GitHub / GitLab / CI。`sync` 只重生成确定性文件，不会替你声称“知识已经复核”。业务文档仍在原路径更新；Agent 完成语义审查后再运行 `record-context-review` 留证。

---

## 接入之后：编码 → 验收 Loop

任务验收入口是 **一条命令**：

```bash
harness-kit task-start --repo .   # 可选；记住任务起点，覆盖之后的 commit
# ... Agent 写代码 ...
harness-kit deliver --repo .      # 影响面检查 + verify + stamp
```

`harness-kit` 只经 npx 分发，不全局安装，所以 PATH 上通常没有这个命令。生成的 `AGENTS.md` 会把每条 Harness 命令写成 `.agents/harness.lock.json` 钉住的完整调用，例如 `npx -y @erzhe/harness-kit@0.7.2 deliver`，与 Hook runner 的调用形式一致；仓库还没有 lock 时用 `@latest`。`deliver` / `verify` / `doctor` / `evidence` 输出的命令提示、Stop 拦截文案和 Hook 失败兜底也用同一形式，生成文件头部只指向 `AGENTS.md` 里钉版本的 `sync`，不再写裸 `harness-kit`。

`run-checks`（以及 `deliver`、execute 模式的 Stop）执行 check 时会注入两个环境变量：`HARNESS_KIT_BASE` 是本次评判的 resolved base commit，`HARNESS_KIT_CHANGED_FILES` 指向一个临时文件，每行一个改动路径（target 相对，含已删除路径）。“只检查增量代码”的规则可以直接用它们，例如 `git diff --check ${HARNESS_KIT_BASE:-HEAD}`，或只对清单里的 `.go` 文件跑 gofmt。

- **有 task base / `--base`**：按任务范围 diff 验收（含已提交改动）
- **没有**：降级为**当前工作区 git diff（相对 HEAD）**，对这些文件跑测
- **干净工作区**：`no-change`（不假装验过历史 commit）
- **复杂任务允许长跑**：`deliver` 不用 7 分钟总预算卡死测试
- **继承的知识过期不算本任务的失败**：主干上有人改了被 `binds` 的文件（比如 bump 依赖改了 `package.json`）却没复核，这类过期在任务 base 上就已存在。只要本任务没碰该知识的输入（绑定源、知识文档本身、manifest 里的声明、`.harness-state.json` 里的复核记录），`deliver` 就把它列为继承项（文本输出的 `context freshness ... already stale on task base`，JSON 的 `inheritedContext`），照常 `accepted`，并在 MAINTENANCE / `nextActions` 里给出精确的 `record-context-review --path|--module ...` 刷新命令，留给维护者处理。独立运行的 `verify` 仍是严格门禁，适合放在 CI 里，在引入过期的那次提交就拦下。
- **未接入的仓库**：目录下没有 `.agents/manifest.yaml` 时，`deliver` 返回 `not-adopted`（退出码 3，JSON `status: "not-adopted"`、`adopted: false`），提示按仓库自身规范验收，不再给出“修完重跑”的误导。如果当前目录在某个 Harness target 之内，会提示到 target 根目录重跑；如果改动落在嵌套 target 里，会列出这些 target 的 deliver 命令。

| deliver status | 退出码 | 含义 |
| --- | --- | --- |
| `accepted` | 0 | 本次改动已验收，stamp 有效 |
| `no-change` | 0 | 没有待验改动 |
| `needs-work` | 1 | 按输出修复后重跑 |
| `not-adopted` | 3 | 该目录未接入 harness-kit：不要重跑，按仓库自身规范验收 |

Stop Hook（可选）默认 **thin**：没有匹配的 delivery stamp 就 block，并提示跑 `deliver --repo <被门禁的 target 绝对路径>`——**不再要求新开会话**。会话开始前已 accepted 的 deliver 戳，只要指纹仍覆盖当前改动，SessionStart 之后照样有效。  
`HARNESS_KIT_STOP_MODE=execute` 可恢复 Stop 内直接重跑验收。这个模式只由运行 Agent 的进程环境变量决定，目前没有项目级配置。

每次 Stop 都会记进该会话的 lifecycle 证据（`evidence --json` 的 `lifecycle`：SessionStart 时间、最近一次 Stop 的模式、放行或拦截、原因）。thin 模式放行时，Stop 接受的 deliver 戳会绑定到这个会话，所以默认安装下，一个全新会话只要让改动经过门禁（deliver 拿到 accepted 后结束一轮），`hookActive` 就会变成 `true`，`doctor` 显示 `ACTIVE`，不需要切换到 execute 模式。干净工作区上的 Stop 只证明 hook 被调用，不算门禁证据。`evidence` 顶层的 `agent`、`hookConfigurationCurrent` 描述最近一条验证记录（常常是手动 deliver），判断 Hook 是否生效看 `hookActive` 和 `hookActiveSource`（`lifecycle` 或 `latest-record`）。

Claude Code 会把新装的项目 Hook 加载进正在运行的会话。这个会话没有 SessionStart，下一次 Stop 就要求整个 worktree 改动有 accepted 的 deliver 戳，所以接入时把 `install-hooks` 放在最后一步，装完立即 `deliver`，不要在等待异步盲审时安装。

诚实边界：没有宿主 Stop / Supervisor 时，会话级强制 Loop 做不到；此时靠 AGENTS 协议 + `deliver` +（可选）Git/CI。Hook 观测（`CONFIGURED/ACTIVE`）是旁路，不是交付成功标准。

其它：

- **Git 钩子是可选增强**：默认只在单 worktree、默认 hooks 路径、无外来 hook 时安装。
- **漂移了让 Agent 自愈**：`onboard` skill + `sync` / `record-context-review`。

---

## 命令

| 命令 | 作用 |
| --- | --- |
| `harness-kit onboard` | 打印 onboard skill 给 Agent（配合 npx 零安装；打印的流程钉住打印它的版本） |
| `harness-kit init` | 铺 `.agents/` 骨架 + 起步 manifest：按 `go.mod` / `Cargo.toml` / `package.json`（lockfile + 真实 scripts）推断命令，默认带 `diff_check` 与 `validation.defaults.no_match`，不套 JS 模板 |
| `harness-kit sync` | manifest → 事务生成 AGENTS.md / CLAUDE.md / reference / routing / modules；不刷新知识复核 |
| `harness-kit upgrade [--check] [--json]` | 把仓库原地升级到当前运行 CLI 版本；确定性迁移 + 生成物刷新 + doctor/verify，不访问 registry/CI/代码托管，也不改 Hook |
| `harness-kit task-start` | 记录本 worktree 任务 base（可选；SessionStart 也会写） |
| `harness-kit deliver` | **任务验收入口**：scope → run-checks + verify → stamp |
| `harness-kit prepare-adoption` | 在仓外生成私有 blind-audit bundle；包含旧入口、嵌套 AGENTS/CLAUDE 及它们显式引用的文档证据、规则迁移后的落点（`.agents/` 下的 knowledge / checks 等和 `root: repo` 文档）和确定性候选，不改仓内文件；找不到仓内文件的纯路径提及列进绑定 hash 的 `unresolved` 清单，交给盲审确认 |
| `harness-kit record-adoption-audit` | 把声明的 pass/fail、理由和审计报告 hash 绑定到一版候选 |
| `harness-kit sync --adopt-existing --candidate ... --audit ...` | 首次接管：只有 live legacy、候选、manifest 和 pass receipt 逐字节一致才事务写入；没有旧入口的仓库也必须核对回执 |
| `harness-kit doctor [--details]` | 体检：完整性 / 路径引用 / 影响面 glob 零命中（逐个 owns / tests glob）/ 漂移 / 新鲜度 / 体量预算；默认折叠无需马上处理的边界 |
| `harness-kit verify [--json] [--details]` | 门禁：跑不变量 + 契约 + 漂移，给出分类后的下一步；失败非 0 退出 |
| `harness-kit accept-contract` | 有意变更接口后，记录新的契约指纹为基线 |
| `harness-kit install-hooks` | 可选装原生 Git hooks；共享 worktree、自定义/全局路径或第三方 hook 时安全拒绝 |
| `harness-kit install-hooks --stop --agents <client>` | 只给实际使用的客户端装生命周期门禁：会话开始记基线；结束时默认要求当前改动有 accepted deliver 戳（execute 模式改为重跑 `run-checks` + `verify`），每次 Stop 都留 lifecycle 证据 |
| `harness-kit install-hooks --stop --agents codex --allow-user-dispatcher` | Codex linked-worktree fallback：保留已有用户 Hook，安装一个惰性分发器并只登记当前 worktree |
| `harness-kit plan-checks` | 只看本次改动会影响哪些模块、该跑什么、还有哪些验证缺口 |
| `harness-kit run-checks` | 真正执行本次改动对应的检查，并保存可追溯证据 |
| `harness-kit evidence` | 查看最近一次验收状态、检查结果和豁免理由 |
| `harness-kit record-context-review` | Agent 完成语义审查后，记录某条知识或模块的内容/来源 hash 与理由 |
| `harness-kit check-loop` | 打印给 Agent 使用的“实现 → 验收 → 修复 → 再验收”指南 |

所有命令都支持 `-C <dir>` 指定目标仓库（默认当前目录）。

### 怎么看验证结果

`verify` 不再把所有无法自动执行的事项混成一个 GAP 数字：

- **REQUIRED | AGENT**：当前 Agent 自动完成后才能收尾，例如安装 Hook、重跑过期 evidence。
- **REQUIRED | HUMAN**：Harness 发现不属于自己的 Hook 或必须由宿主授权，只请你确认这一项具体变更。
- **RECOMMENDED**：自动化覆盖可以继续改善，只在首次接入或专门维护 Harness 时处理，不扩大普通业务任务。
- **INFORMATIONAL**：发布、真实网络、生产上传、后台服务等只在相关任务中验证，不是失败，也不需要平时逐条处理。

默认文本只展开当前必须处理的动作；`--details` 展开全部声明，`--json` 提供 `gapDetails`、`gapSummary` 和 `nextActions` 给 Agent 稳定执行。`verify: OK` 表示声明的确定性门禁已通过；只有同时显示 `Harness readiness: READY`，才表示 Lifecycle Hook 等初始化收尾也已完成。

首次接管是一个窄状态机，不靠 Agent 记住长说明：`init` 保存将被接管的旧入口 → `prepare-adoption` 在仓外收集原地 guidance、规则落点并生成候选 → 独立 Agent 盲审 → `record-adoption-audit` 绑定报告 → 带 candidate/receipt 的 `sync --adopt-existing` 才能写真实入口。盲审者在 bundle 的 `landing/` 里就能核对每条旧规则迁到了哪里，不需要另附副本。manifest、旧入口、snapshot/index、嵌套入口/显式引用文档、unresolved 清单、落点、候选文件或审计报告任一变化，旧回执立即失效；裸 `--adopt-existing` 直接报错，没有旧入口的仓库也要走同一个回执检查。

引用闭包按写法区分：Markdown 链接和 `@path` import 解析不到仍然 fail closed；正文或代码块里的纯路径提及（目录树示意、简写文件名、外部知识库路径）先按引用文件目录、target 根、再按中间祖先目录（Skill / package 根）解析，都找不到才记成 `unresolved`。存在但不安全的目标（二进制、仓外 symlink 等）一律 fail closed。回执明确写 `assurance: declared`、`independence: unverified`：它能强制顺序和准确字节，不能在没有外部身份系统时伪装证明“审计者一定独立、语义判断一定正确”。

## 实现之后，怎么保证真的验收了

举五个常见场景：

- **修旧 bug**：Agent 改了生产代码，却没补回归测试。关键模块配置为 `test_touch: required` 后，结束时会直接拦住，直到补测试；若测试确实不适用，可对这个覆盖缺口留下有范围、有理由的豁免。
- **前端 / Electron 只跑了单测**：把真实浏览器用户流、桌面进程边界或 IPC 验收声明成 `validation.gates`，再由相关 `modules[].gates` 引用。模块一旦受影响，gate checks 必须执行，`--profile` 也不能降级成 unit-only；若 gate 要求同步维护 acceptance tests，普通单测文件不能冒充这份覆盖。
- **代码已经 commit**：门禁从会话开始时记住基线，所以不会因为 `HEAD` 前进就误判“没有改动”。
- **客户端 hook 没触发**：手动开始任务时先记下 `git rev-parse HEAD`；若中途已经 commit，用 `run-checks --base <task-start-sha>` 验收。未提供任务起点的手动 `no-change` 不算交付证据。
- **检查根本没跑**：命令不存在、被标成后台任务/有副作用、Git base 无效或 manifest 写坏，都算 `not-verified`，不会再用“跳过”冒充成功。

项目接入时，由 Agent 根据模块风险提议策略，人来 review：默认只是提醒；公共接口、核心逻辑等关键模块再设为强制。已有真实 E2E 的用户可见边界应把 manifest 升到 `ai-harness/v1` 后声明为 gate；这样只认识 v0 的旧 CLI 会拒绝，而不会静默忽略。没有真实 runner 或用例时，必须把具体人工旅程持久化为 `invariants[].manual: true` 并从相关模块 playbook/pitfall 指向它，不能只在聊天里留一句 GAP，更不能编造命令或空 glob。每次结果会落到当前 worktree 的私有 Git 状态里，`harness-kit evidence` 随时可查。只有“没补测试 / 模块暂时没测试 / 必需范围未映射”这三类覆盖缺口可豁免；检查没跑、配置写坏、gate 边界失效、Git 对比失败等系统问题不能绕过。豁免只对当前代码指纹有效，代码一变就失效。

注意：客户端显示“hook 已安装”不等于它真的执行过。`doctor` / `verify --json` 的 Hook 状态会区分：有效配置齐全但尚无新会话证据是 `CONFIGURED`；最近一个 hook 会话的门禁证据有效（execute 模式下 Stop 自己跑的两道门，或 thin 模式下 Stop 接受的 deliver 戳），并且 SessionStart 绑定的完整有效配置指纹仍与现场完全一致，才是 `ACTIVE`；runner 缺失、配置残缺、配置/override/分发器/登记改变、证据失败或 stale、最近一次 thin Stop 拦截都是 `DEGRADED`。`evidence` JSON 的 `hookActive` 使用同一配置绑定；交付证据本身仍可能有效，但它不会继续替另一版 Hook 配置背书。Codex linked worktree 必须显式使用 `--allow-user-dispatcher`；Cursor 的部分 headless/cloud surface 仍可能不触发生命周期 hooks，CLI 不会伪造成功。

普通 worktree 的 Agent Hook 只写项目内普通文件：runner 与所选客户端配置会先整组预检，再事务写入，最终路径及父目录都不能是软链接。已有 JSON 的 `hooks` 结构无法安全合并、或 runner 属于第三方时，整组拒绝且不留半套文件；`--force` 也不会覆盖第三方 runner。合法的第三方 hook 数组条目会原样保留，只替换与安装器生成的 runner、Agent、事件和失败兜底完整匹配的 Harness 命令；仅仅在注释里出现 marker 不算我们的 Hook。

Codex linked-worktree 是一个受限例外：安装器会从项目 `.codex/hooks.json` 中移除且只移除 Harness 自己的 SessionStart/Stop 命令，保留第三方项目 Hook；然后以 compare-and-swap 方式更新 Codex 的**用户 Hook 源配置**，加入两条精确 managed 入口和版本化、兼容 Node 18 的分发器，最后把当前 worktree 的登记以 `0600` 写进其私有 Git admin dir。这样普通仓库只走项目 Hook，linked worktree 只走用户分发器，不会因为客户端行为变化把同一轮检查跑两次。普通 Codex 的源配置就是当前 `$CODEX_HOME`（未设置时为 `~/.codex`）；Orca 的 `$CODEX_HOME` 是每次创建终端时由 `~/.codex` 派生的运行时副本，因此安装器会自动写 `~/.codex` 源配置，并要求新建一次 Orca Agent 会话让它安全同步。Harness 不改 Orca 的生成脚本、当前运行时文件或 Hook 信任记录。其他用户 Hook 条目的语义内容与相对顺序保持不变；未登记仓库静默不执行，登记存在但路径、权限、runner hash 或配置不一致则 fail closed。未知 JSON、同名外来分发器、并发修改都会让安装失败，且登记最后写入，因此不会留下“看似激活”的半套状态。这不是原生 Git hook，也不会影响其他 worktree 的业务文件。

`evidence` 不是旧绿灯截图：每次读取都会重新核对当前代码和完整验证计划（profile、gates、checks、gaps），任一变化或旧证据缺少计划指纹都会标 `stale` 并返回失败。手动执行时，`run-checks` 只会得到 `runChecksValid`；随后对同一代码运行 `verify`，整体 `valid` 才会变成 true。若会话开始时工作区已经有未提交改动，门禁会把这些既有改动也纳入验收范围，并在 evidence 里列出；它保证不漏，不冒充精确的任务归因。

测试文件按最终工作树状态判断：只有新增或修改才满足 `test_touch`，哪怕先暂存修改、随后又删除，也不会被当成“补过测试”。改动指纹还包含可执行位与 submodule 当前提交/脏状态，避免代码内容没变时误沿用旧证据。自动 checks 最多共享 7 分钟，随后 `verify` 最多 2 分钟，确保在客户端 10 分钟 hook 上限前仍能返回明确的拦截结果；超时本身就是失败。

### 已有业务文档不用搬家

`knowledge.path` 不是固定目录规则。它可以指向 `.agents/` 内由 Harness 新建的知识，也可以登记仓库里任何已有相对路径：

```yaml
knowledge:
  - root: repo
    path: engineering/tribal-notes/api.md   # 文件夹名完全由业务仓库决定
    role: api
    authority: derived
    binds: [src/api/router.ts]
  - root: agents                           # 默认值
    path: knowledge/security-policy.md
    authority: policy
    binds: [src/auth/index.ts]
```

`root: repo` 只表示“从仓库根解析”，不是把 `docs/`、`knowledge/`、`context/` 三个名字写死；CLI 也不会复制这些文件。`authority: derived` 表示文档应跟代码事实同步，`policy` 表示文档约束代码，`review` 表示两边需要 Agent 做语义核对。三种都必须先分析，再由 Agent 运行 `record-context-review --path ... --reason ...`；命令只保存证据，不会替 Agent 做判断。

---

## 它解决什么问题

传统工程化（脚手架 / lint / CI）是**面向人、面向过去**的。Agent 需要的是显式、结构化、可机器消费的知识：

- **这是什么** → `identity`（name / summary / scope）
- **怎么跑** → `capabilities`（setup / build / test / dev…）
- **什么绝不能破** → `invariants`（声明式正则门禁）+ `contracts`（接口指纹基线）
- **改东西看哪** → `routing`（按改动类型导航）+ `modules`（模块卡）
- **哪些验证不了** → 分类后的验证边界与 `nextActions`（明确何时需要、谁来处理）

harness-kit 把这些沉淀进 manifest，再确定性地生成与校验。

---

## 工作原理

```
.agents/manifest.yaml ──sync──> Agent 入口 / 路由 / 模块图
          │
          └── 本次 diff ──plan-checks──> 影响模块 + checks + gaps
                                      │
                                      └──run-checks + verify──> evidence / 继续修
```

- **不变量**：声明式正则 `enforcement`（确定性、无 LLM），或标 `manual`
- **契约**：`snapshot` 打印接口指纹 → CLI 存基线并 diff（协议无关）
- **新鲜度**：知识条目可登记任意 repo 内相对路径；`authority` 决定语义责任，Agent 审查后记录内容与 `binds` hash，任何一侧变化都会失效
- **验证边界**：打包 / 真网络 / 生产上传等本地验证不了的，按场景保留；默认不冒充故障反复提醒

---

## 让 Agent 自动触发（可选）

上面的"最快上手"是**显式调用**——你每次说"onboard 本仓库"，Agent 才会做。如果你想让某个 Agent **自动识别**"该给仓库接 harness-kit"，可以把 skill 软链进它的 skill 目录：

```bash
# Cursor
ln -sf "$(npm root -g)/@erzhe/harness-kit/skills/erzhe-harness-init" ~/.cursor/skills/

# Claude Code
ln -sf "$(npm root -g)/@erzhe/harness-kit/skills/erzhe-harness-init" ~/.claude/skills/
```

这样当用户说"给这个仓库配置 harness"时，Agent 会自动找到并执行这个 skill。

---

## 开发

```bash
pnpm install
pnpm typecheck          # tsc --noEmit
pnpm test               # node:test + tsx
pnpm build              # esbuild → dist/harness-kit.cjs
pnpm exec tsx src/cli.ts verify --repo .   # 自托管验证
```

## 文档

- [`SPEC-v0.md`](SPEC-v0.md) — manifest schema + 生成/校验契约

## License

MIT © [MeCKodo (二哲)](https://erzhe.me/)
