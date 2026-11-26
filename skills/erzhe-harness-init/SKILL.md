---
name: erzhe-harness-init
description: 给一个仓库接入 harness-kit —— 引导 agent 做仓库考古、保真迁移现有 agent 规则、把隐性工程知识翻译成 .agents/manifest.yaml，再用 sync/doctor/verify 和会话证据验证到绿。当用户说"给这个仓库配置 harness / 初始化 AI 脚手架 / 生成 AGENTS.md 契约层"时使用。
---

# erzhe-harness-init

把**当前仓库**改造成 agent 友好：保全既有规则，产出填好的 `.agents/manifest.yaml`，并让 `harness-kit doctor` healthy、`harness-kit verify` 退出码 0。

CLI 只负责机械骨架、确定性生成与门禁；**理解仓库、分析文档语义、运行 context review** 是 agent 的工作。

## 0. 定位 harness-kit 命令

harness-kit 只经 npx 分发，不全局安装，PATH 上通常没有 `harness-kit`。整个接入只用**一个明确版本**，下文的 `harness-kit <cmd>` 都指这条调用（包名 `@erzhe/harness-kit`）：

- **首次接入**：用打印本 Skill 的那个版本，即输出顶部的 `npx -y @erzhe/harness-kit@<version>`。入口可以是 `npx -y @erzhe/harness-kit@latest onboard`，但之后每条命令都写这个具体版本，不再写 `@latest`。`init` 会把它记进 `.agents/harness.lock.json`，生成的 `AGENTS.md` 也会钉住它。
- **仓库已有 `.agents/harness.lock.json`**（重新接入、维护）：一律用 lock 钉住的版本，与 `AGENTS.md` 里 “Harness CLI” 那一行一致。换版本只能通过 `upgrade`，不要混用版本。
- 在 harness-kit 源码仓内开发：`pnpm exec tsx src/cli.ts`（源码仓里 npx 会被同名本地包遮蔽）。

先跑一次 `--help` 确认可用。

## 1. 首次接入前：全量盘点与保真

在任何 `init` / `sync` 或入口文件改写之前完成：

1. **做全仓文档清单**：盘点仓库内每一份现存的 `AGENTS.md`、`CLAUDE.md`（包括被 `.gitignore` 忽略但真实存在的嵌套入口），以及其他客户端的常驻规则文件（`.cursorrules`、`.cursor/rules/**`（含 `alwaysApply` 的 `.mdc`）、`.windsurfrules` / `.windsurf/rules/**`、`.clinerules`、`.roorules` / `.roo/rules/**`、`GEMINI.md`、`.github/copilot-instructions.md`、`.github/instructions/*.instructions.md`、`.junie/guidelines.md`，任意目录层级），并递归追踪它们显式引用的每一份仓内文档。`prepare-adoption` 会把这些客户端规则文件当作 guidance 自动收进 bundle，不需要再手动以 `root: repo` 登记才能让审计者看到。文档目录名不限；不以 `docs`、`knowledge`、`context` 等文件夹名做白名单。支持 Markdown 链接、`@path` 和带 `.md/.mdx/.markdown/.txt/.rst/.adoc/.asciidoc/.org` 扩展名的纯路径。Markdown 图片、普通代码和资产链接不是 guidance。`prepare-adoption` 的规则相同：链接和 `@path` 解析不到会 fail closed，要先修正旧文档或升级给负责人；纯路径提及（目录树示意、简写文件名、外部知识库路径）先按引用文件目录、仓根，再按中间祖先目录（Skill / package 根）解析，仍找不到的进入 bundle 的 `unresolved` 清单，由盲审逐条确认，不需要为此改业务文档。路径只认 ASCII 字符，紧跟中文或中文标点（`knowledge/a.md、`）也能识别；`api-sg-edge.example.org` 这类无协议域名解析不到时不算提及。
   **没有旧入口时**，隐性规则主要在代码注释和提交说明里。看提交说明要覆盖**全部分支**：`git log --all` 之外，再用 `git ls-remote` 对照远端分支。镜像或 worktree 可能只同步了基准分支，hotfix 和在途分支会被漏掉。把提交说明写进 `dont_assume` 的“正确：”之前，先读代码核对；说明与代码不符时以代码为准。
2. **先记录 legacy entry 的只读基线**：逐文件记录仓内路径、原始字节 hash、文件类型和 symlink target；不得格式化、改编码或归一化换行。下一节由 `init` 把这份事实落成 byte-preserving snapshot，不能靠复制粘贴重建。
3. **建立逐规则 preservation ledger**：原入口中的每条约束各占一行，记录来源定位、原意、新落点、保留/改写/删除状态及理由。不能把多条规则合并成一条来掩盖遗漏。
4. **业务文档原地保留**：不得移动、重命名或复制既有业务文档；直接以原路径注册。仓内 legacy snapshot 只保存 Harness 将实际接管的 managed entry；嵌套入口和引用文档仅在仓外私有审计 bundle 中留证。

每个注册到 `knowledge` 的条目都显式填写：

- `root: agents | repo`：`agents` 表示 `.agents/` 下由 agent 维护的知识，`repo` 表示留在仓库原路径的既有文档；目录名不决定 root。
- `authority: derived | policy | review`：`derived` 是可由代码、测试、本地配置推导的描述；`policy` 是规范性约束；`review` 是需要复核的材料。
- 对明确过时的 `derived` 描述，用代码、测试和本地配置证据**在原文件原地更新**。`policy` 文档约束代码，不能因当前实现不同就反向改掉政策。authority、含义或取舍存在语义歧义时，升级给用户决定，禁止自行猜测。

## 2. 铺骨架（若还没有 `.agents/`）

```sh
harness-kit init --repo .
```

生成 `.agents/{manifest.yaml, knowledge/, playbooks/, adoption.md}` 骨架（起步 capabilities 按 `go.mod` / `Cargo.toml` / `package.json` 的 lockfile 与真实 scripts 推断，默认带 `diff_check` 和 `validation.defaults.no_match: [diff_check]`；它们只是起点，第 3 步逐条按真实命令核对、改写），并在 `.agents/adoption/legacy/` 保存 Harness 将接管的 **managed legacy entry**；每个 legacy entry 的 byte-preserving 快照还要绑定 mode 与索引。立刻逐项核对索引 hash / mode / symlink target 与第 1 步基线；不一致就停止，不能继续接管。adoption 父目录/index/snapshot 出现 symlink 时必须 fail closed。若并发导致索引事务失败，整个 init 仍算失败；错误里列出的 append-only snapshot 是保留给恢复审查的证据，不得自动删除或把它误判成已完成接管。已存在任一 scaffold 目标时普通 `init` 必须零写入拒绝；不得用 `--force` 绕过尚未保真的入口。

## 3. 仓库考古 → 填 manifest（核心）

**纪律：**

- 不臆造。先用代码、测试、实际脚本和本地配置取证；只有语义歧义才问用户。
- 能自动验证的就给命令（`enforcement` / 契约 `snapshot`）；验证不了的诚实标 `manual`，别假装能检查。
- `AGENTS.md` 有体量预算：150 行，仓库内容（summary、scope、依赖、命令、契约、不变量）500 词；固定的生成头、Working agreement 和 Knowledge & maps 不计。汉字和假名每个算半个词，中英文之间加不加空格词数相同，所以中文入口按真实篇幅计数。超了 doctor 会列出最大的几段，通常是不变量：规则只写 Agent 必须遵守的那句话，理由和范围放进 knowledge。细节沉到 `.agents/` 或注册原地文档，manifest 只写精选。

按顺序逐块填 `.agents/manifest.yaml`（schema 见 harness-kit 的 `SPEC-v0.md`）：

1. **identity**：读 README、包/构建配置和顶层目录。填 `name`、一句话 `summary`、`scope_in` / `scope_out`、`upstream` / `downstream`。`scope_out` 会渲染成 “Out of scope (do NOT modify here)”，只放本仓**不得修改**的东西；“相关知识在业务知识库”“配置在运营后台”这类指路事实写进 knowledge、invariants 或 `downstream`，否则会被 Agent 读成禁令。
2. **capabilities**：从真实 scripts、Makefile、justfile 和自动化配置提取 setup / build / test / dev / lint / release。实际运行或检查入口；长驻的标 `background: true`，有副作用的标 `mutating: true`。旧规则只约束增量代码时（例如“对改动文件执行 gofmt”），check 用 `run-checks` 注入的 `HARNESS_KIT_BASE`（任务 base commit）和 `HARNESS_KIT_CHANGED_FILES`（改动清单文件，每行一个路径，含已删除路径）按任务 diff 实现，不必给存量文件建 hash 基线。
3. **environment**：从 `.env.example`、配置和 README 抓关键环境变量。危险的标 `secret: true`、必需的标 `required: true`。
4. **contracts**：识别 HTTP、CLI、公共 API、proto/schema/IDL、事件等对外接口，尽量给打印当前接口指纹的 `snapshot` 命令。过滤注释/生成物噪音；含复杂引号、正则或管道时下沉到 `.agents/checks/<id>.sh`，脚本从仓库根运行并固定 `LC_ALL=C`。无法自动检查才写 `manual_verify`。`breaking_needs` 只在仓库真的给接口发版本号时填写；没有版本号就省略，漂移时按契约说明处理后 `accept-contract`。契约 snapshot、check 脚本和 binds 的**文字说明必须与实际覆盖面一致**：脚本头逐项写出截取哪些文件或语句、怎样归一化；派审前先跑一组漂移负例（改一处接口必须 fail）和噪音负例（只改注释或格式必须不漂移）；journal 和 knowledge 里不写“全部来源都已绑定”这类穷举说法。
5. **invariants**：从 policy、现有 agent 入口和真实代码约定提炼“必须始终成立”的规则。AGENTS.md 会渲染每条规则的 `id`，scope、routing 和模块卡可以直接写“见不变量 `<id>`”。能表达成 `enforcement` / `check` 就执行化，否则标 `manual: true`。`forbid_pattern` 是不带 flag 的 JS 正则，逐行匹配；`path_glob` 用 fast-glob 且 `dot: false`，通配符不进点目录，`node_modules` / `dist` 等始终排除（见 SPEC §3）。规则文字写的扫描范围不能比这更大。
6. **modules + validation**：按真实模块边界填写 `role`、具体 `entry` 文件、上下游、`must_know`、`pitfalls`，并完成可执行影响面（旧入口有“不写目录 / 不列清单”类原则时，`role` 只写一句边界说明，不复述目录；可选的 upstream/downstream 模块依赖图默认不写，见 §4 的冲突处理）：
   - 首次接入必须给真实生产面填写 `modules[].owns`、真实覆盖文件填写 `modules[].tests`、真实可运行 capability 填写 `modules[].checks`，再用 `validation.required_coverage` 覆盖真实生产根。
   - 每个 `owns` / `tests` / `required_coverage` 正向 glob 写入前都要对仓库文件清单实际求值并确认命中；不得套用惯例路径、发明 glob 或使用 `!` 否定 glob。真实不存在的测试/检查要报 GAP，不能造一个来过门禁。
   - Harness 自己的路径（`.agents/**`，含 `.agents/checks/` 下的检查脚本和程序、`AGENTS.md`、`CLAUDE.md`、install-hooks 写的 `.claude/settings.json` / `.cursor/hooks.json` / `.codex/*`）由 `verify` 判定，不会算 unmapped，也不会被 `required_coverage: ["**/*.go"]` 这类 glob 拦住；只改这些路径时，没配 `no_match` 也不会报 no-checks-selected。这只是**免检，不挑选检查**：只为覆盖而建的模块可以删，挂了 `go vet`、`gofmt` 之类 checks 的模块要保留，否则这些检查会静默消失。capability 的 `run` 直接引用的脚本或目录（例如 `bash .agents/checks/go-test.sh`、`go vet ./.agents/checks/snapshot`）改动时，会自动选中该 capability（只限 manifest 里当作 check 用到的 capability；setup、启动器、发布脚本不算）。这类模块不要把 `.agents/manifest.yaml` 写进 `entry`，否则每次改 manifest 都要重新复核。
   - `checks` 只能引用已声明、可终止、无副作用且亲自验证可运行的 capability 动词。用 `plan-checks` / `run-checks` 验证真实改动能选中预期模块、测试与检查。
   - `test_touch` 按实际风险设为 `required | advisory | off`；公共接口、核心业务、安全边界优先 `required`，不能全仓拍脑袋一刀切。
   - 做一次**用户可观察行为的验证面审计**：从真实 scripts、测试配置与测试文件识别浏览器用户流、桌面进程边界、main/preload/renderer/IPC、CLI/API smoke 等项目实际存在的 acceptance/E2E 检查。领域名称由项目定义，Harness 核心不内置 taxonomy。
   - 已有可终止、无副作用的 E2E/acceptance 命令时，先把 manifest 升为 `spec: ai-harness/v1`，再用 `validation.gates` 声明 mandatory checks，并由有真实 `owns` 的相关 `modules[].gates` 直接引用；不能只放在 `routing.verify` 或可选 profile。v1 让旧 CLI fail closed；gate 会在普通 Stop 中自动执行，profile 也不能绕过。
   - gate 的 `acceptance.tests` 必须只覆盖该层验收 case，并显式声明 `test_touch`。不要把 unit 与 acceptance glob 混在一起；修改 unit test 不能满足 gate 的 acceptance touch。
   - 没有真实 E2E/acceptance runner 或 case 时不得发明命令、文件或 glob 来做绿；先判断能否在本次 onboarding 内安全补一个自启动、自清理的最小关键旅程。若不能，必须把触发范围、操作步骤和成功标准持久化为 `invariants[].manual: true`，并从相关 module 的 playbook/pitfall 指向它；不能只在最终聊天里报告，也不得宣称用户路径已自动覆盖。
7. **routing**：按常见改动类型写 `read`、`entry`、`dont_assume`、`verify`。`routing.verify` 是给 agent 读的最小提示；`modules.checks` 是供 `run-checks` 执行的 capability，别混用。
8. **knowledge**：把第 1 步的文档按 `root` / `authority` 注册；只新增代码推不出的领域知识、坑和决策，重要决策写 journal ADR。`binds` 必须是实际源文件，用于新鲜度检查；旧原则与 binds 是否冲突拿不准时，把它列进待负责人确认的清单。新鲜度按字节判断，绑定源只加一行注释也要重新复核，所以**只绑定文档真正描述的那几个文件**：一份 domain.md 绑定几十个文件，日常改代码几乎每次都要复核。

## 4. 语义复核与首次接入盲审

完成仓库分析、manifest、knowledge 和 preservation ledger 后：

1. 由 **Agent 在分析之后**逐个记录已复核的 knowledge / module（两种 target 分开运行，并写具体证据）：
   ```sh
   harness-kit record-context-review --repo . --path <knowledge.path> --reason "<reviewed code/test/local-config evidence>"
   harness-kit record-context-review --repo . --module <module.name> --reason "<reviewed entry and module boundaries>"
   ```
   `--path` 填 manifest 里的 `knowledge.path`，也接受 `.agents/knowledge/x.md` 这类仓库相对写法；`--path` / `--module` 可以重复，一次记录多项。`record-context-review` 只记录已经完成的分析，**绝不能替代分析**，也不能由 `sync` 暗中代跑。复核记录写在 `.agents/.harness-state.json`，必须和其他接入文件一起提交，否则新克隆里的 `verify` 会因缺少复核而失败。
   有 snapshot 契约时，确认当前接口符合 policy 后，在这一步就运行 `harness-kit accept-contract --repo .`。契约基线 `.agents/contracts/*.snapshot` 和复核记录 `.agents/.harness-state.json` 都是 bundle 的落点证据，盲审之后再 accept 或再记复核，回执就会失效。
2. 普通 `harness-kit sync --repo .` **不会创建首个 `AGENTS.md`**，有没有 legacy 入口都一样；仓库有 legacy 入口时，它还会拒绝覆盖尚未接管的 legacy 入口。可以跑一次确认它拒绝；如果直接写成功，按安全缺陷停止。不要为了过这一步手删、移动或改写真实入口。接入已有仓库**绝不用 `sync --create-entry`**：它只给仓内没有任何 agent 指引的新仓库跳过盲审，而且检测到指引时会拒绝。已有仓库一律走下面的 prepare → 盲审 → `sync --adopt-existing`，后者在没有旧入口时也会核对回执。
3. 用 CLI 在仓库外生成不可直接激活的审计候选（输出目录必须不存在或为空）：
   ```sh
   harness-kit prepare-adoption --repo . --out <external-empty-candidate-dir>
   ```
   bundle 会私有保存 managed legacy byte/mode/link 证据、所有嵌套入口、其他客户端规则文件与递归显式引用文档的 guidance 证据、manifest/index 证据、确定性生成候选（`generated/`：AGENTS/CLAUDE/reference/routing/modules），规则迁移后的**落点证据**（`landing/`：`.agents/` 下手写的 knowledge、checks、playbooks、contracts 基线、`harness.lock.json`、`.harness-state.json` 等，和 `root: repo` 登记的原地文档），`.agents/` 外的其他接入改动（`worktree/`，例如新增的 `.prettierignore`），以及 `INDEX.md`：它把每个仓内路径映射到包内文件，并写明按设计不在包里的内容（hooks 与客户端 hook 配置在接管后才装）。这些都进入 candidate hash；apply 时逐字节复核，盲审后再改任何一项都会让回执失效。prepare 输出的 WARN（JSON `preconditions`）列出应在盲审前完成的步骤（契约基线未 accept、复核未记录、hooks 已提前安装），先处理再用新的空目录重新 prepare。`candidate.json` 的 `unresolved` 列出找不到仓内文件的纯路径提及（来源文件、原文、`missing` / `outside-repository`），同样进入 hash 并在 apply 时重新比对。它**不会写真实入口或复制业务文档到仓内**。`sync` 仍然只根据 manifest 重生成确定性文件；它不分析仓库、不更新业务或 knowledge 文档、不决定规则语义。
4. 在宣布首次接入完成前，派一个**全新、独立的 agent/context 做 blind audit（盲审）**：只给 bundle 目录（从 `INDEX.md` 读起；legacy、guidance、`generated/` 候选、`landing/` 落点和 `worktree/` 改动），不给 preservation ledger、迁移结论或预期答案，也不要另附 bundle 之外的“落点副本”。让审计者独立枚举旧规则，逐条在 `generated/` 或 `landing/` 里找到落点并判断是否保留，并逐条判定 `unresolved`：是 `guidance/` 或 `landing/` 里已有文件的简写，是目录树示意、外部知识库等非 guidance，还是仓内确实缺失的文档（后者若承载规则就是缺口，判 fail 或列给负责人）。报告写到仓库外，之后才与 ledger 对账。审计说明里同时写明下面“写作原则与门禁配置”的判定标准，避免审计者把机器门禁误判为违反旧原则。
   自写检查脚本的验收标准也写进审计说明：脚本覆盖规则字面的核心情形，并在脚本头写清 Limits，就算合格；审计者不要为了构造新的绕过写法反复判 fail。每句覆盖面声明都要有对应负例，派审前先跑；ADR 不转述脚本的 Limits，引用脚本头即可，否则两处会对不齐。首次接入可以只把一两条最关键的约定做成 check，其余先标 `manual`。
   审计者先把报告写成文件、只给一个最终结论；以最后落盘、你实际读过的那一份为准，`record-adoption-audit` 绑定的就是它的 hash。
5. 发现明确缺口时，审计者给 `fail`，当前 agent 自动修 manifest/knowledge/ledger、重新运行 context review，并用**新的空目录**重新 `prepare-adoption`，再交给新的独立上下文重审；旧 bundle/receipt 不得复用。**清晰缺口的修复和复审不找用户代劳**，循环到无明确缺口。
6. 只有规则含义、authority 或冲突取舍存在语义歧义时才升级给用户；得到决定后写入 ledger 并再次盲审。
7. **盲审通过后**，先把“声明通过”的报告绑定到这一版候选，再用同一对证据接管：
   ```sh
   harness-kit record-adoption-audit --repo . --candidate <candidate-dir> --verdict pass --report <external-audit-report> --reason "<review result>" --out <external-receipt>
   harness-kit sync --repo . --adopt-existing --candidate <candidate-dir> --audit <external-receipt>
   ```
   apply 时 CLI 会重新发现并核对 live legacy、snapshot/index、guidance inventory/bytes/mode/topology、unresolved 清单、落点 inventory/bytes/mode、manifest、候选每个字节和报告 hash；任一变化都让回执 stale。receipt 的 `assurance=declared`、`independence=unverified` 只证明顺序和字节绑定，**不冒充 Agent 身份或语义判断质量**。没有精确 pass receipt 的裸 `--adopt-existing` 必须失败。以后入口已带 managed header，日常只用普通 `sync`。接管后需要复审时，照常对真实仓 `prepare-adoption`：legacy 快照仍与 index 一致，就会生成同样的复审候选。

### 旧入口的写作原则与门禁配置冲突时

旧入口常有“不写目录结构 / 不列接口清单 / 不列下游”这类**写作原则**，原意是不要维护会过时、会误导 Agent 的手写清单。Harness 必须声明的 `modules[].owns/tests/entry`、`routing.read`、`validation.required_coverage` 和契约 `snapshot` 看起来与之冲突，按下面的标准处理，不要让盲审为此反复 fail：

1. **判定是否真冲突**：门禁配置是被机器持续校验的声明，不是叙述性清单。路径或 glob 失效时 `doctor` 会报零命中，入口文件缺失会报错；接口变化会让 `verify` 的契约 snapshot 漂移失败。只有在 `must_know`、`pitfalls`、knowledge 或生成入口里**用文字复述**目录树、接口列表、下游清单，才算违反原则，这种复述要删掉，改成指向门禁或源码。试点里同类冲突还出现在四处：模块 `role` 只写一句边界说明，不复述目录；可选的模块 upstream/downstream 依赖图没有机器校验，属于叙述性清单，旧原则禁止时就不写；`identity.upstream` / `downstream` 会原样渲染成根 AGENTS.md 的 “Dependencies” 一节，同样属于叙述性清单，旧原则禁止列上下游时留空；knowledge `binds` 是新鲜度门禁，按下面第 2 条记为“改写”。旧入口自带“复核指纹 + 探针”一类机制、且复核时还有待定项时，不要补新指纹让探针复位，结论写在原位注释旁，列给负责人。
2. **在 ledger 里记为“改写”**：写清原意（防止过时清单误导）、新落点（哪几项配置）、防漂移机制（具体是哪条 doctor 检查、verify 契约或 check 型不变量），以及“正文不复述清单”的约束。
3. **告诉审计者同一判定标准**：门禁配置只要有防漂移机制，就按“改写并保留原意”判断；审计者只对文字复述的清单判 fail。
4. **何时上报负责人**：旧原则明确禁止的就是这类机器声明（例如“任何文件里都不得出现路径或接口清单”），某项声明没有可执行的防漂移手段，或者负责人此前就这类取舍有过不同决定时，不要自行裁决。把选项写清楚：A 接受门禁配置，由 doctor/verify 防漂移；B 缩小或去掉该声明，改为 `manual` 验证边界并承担覆盖缺口。由负责人决定，并把决定写入 ledger 和接入说明。

## 5. 验证到绿

```sh
harness-kit doctor
harness-kit verify
```

- 路径不存在就修 manifest；impact glob 零命中就回到真实文件清单修正，不能扩大假 glob。
- 契约基线按 §4.1 在 prepare 之前 accept；这里仍提示 baseline 未设置，说明漏了那一步：先确认当前接口符合 policy，再运行 `harness-kit accept-contract --repo .`，然后重新 prepare 并盲审。拿不准是否 breaking 就升级给用户，绝不静默 accept。
- 读取 `NEXT ACTIONS`（JSON 为 `nextActions`）：`required | agent` 由你立即完成；`required | human` 只向用户请求那一个明确授权或语义决定，不能把技术选型抛给用户。
- 首次接入本身就是 Harness 维护任务，所以 `recommended` 的自动化改进也要逐项判断并尽量完成；确实无法自动执行的条目改成有明确时机和步骤的人工验证边界，不能只留下“GAP”。
- 迭代到 `doctor` repository configuration healthy、`verify` 退出码 0、所有 `required` action 清零。`informational` 只表示按需验证边界，不是待修问题。

## 6. 自动安装有效的会话门禁并验证

作为首次接入收尾、在宣称完成之前，由 agent 完成下面的判断和安装，**不让用户选择项目 Hook 或用户分发器等实现方式**。会话门禁是接入的**最后一个改动**：必须在盲审 pass、接管完成、`verify` 到绿之后再装，绝不在等待异步盲审时安装。Claude Code 可能把新装的项目 Hook 热加载进当前会话，也可能到下一个会话才执行。热加载时当前会话没有 SessionStart，下一次 Stop 就要求整个 worktree 改动都有 accepted 的 deliver 戳；没热加载时当前会话不会留下 lifecycle 记录。两种情况都一样处理：装完立即运行 `harness-kit deliver --repo .` 拿到 accepted，再结束这一轮，`hookActive` 留到下面的全新会话里证明；被拦截时按拦截文案 deliver 即可，这是门禁在工作，不是故障。

门禁不会无限拦截：registry / npx 不可用时，干净工作区的 Stop 直接放行，有改动时只拦一次；runner 文件缺失或异常退出时，客户端配置里的外层兜底同样每轮只拦一次，放行时提示未验证；CLI 可用但这个会话交付不了（例如只读的 `claude -p`）时，改动没变就不会连续拦两次，第二次放行并记为 lifecycle `loop-exit`。这些放行都**不是**交付证据：照实告诉用户改动未验证，`loop-exit` 后 hooks 显示 DEGRADED，直到下一次真实交付。

1. 只为当前真正使用的客户端安装 SessionStart/Stop hooks，并把 `claude`、`cursor` 或 `codex` 显式传给 `--agents`；不要因为 CLI 支持多个客户端就默认全装。
2. 运行 `git rev-parse --absolute-git-dir` 和 `git rev-parse --path-format=absolute --git-common-dir`。两个规范化路径相同就是普通 worktree；不同才是真正的 linked worktree。不能只看根目录 `.git` 是否为文件，因为 submodule 也是这种外观。
3. Claude Code、Cursor 和普通 worktree 里的 Codex 使用项目级安装，例如 `harness-kit install-hooks --repo . --stop --agents codex`。如果当前客户端是 Codex 且两个 Git 路径不同，直接使用安全 fallback：

```sh
harness-kit install-hooks --repo . --stop --agents codex --allow-user-dispatcher
```

Codex fallback 会保留用户 Hook 源配置里的其他 Hook，只加入一对固定的 SessionStart/Stop 调度入口和一个版本化分发器；同时从项目 `.codex/hooks.json` 移除且只移除 Harness 自己的命令，第三方项目 Hook 原位保留。这样 linked worktree 始终只有用户分发器这一条 Harness 路径，不会因某个 Codex surface 又开始读取项目 Hook 而重复跑检查。当前 worktree 的登记放在它自己的 Git admin dir。未登记的仓库会直接不执行，登记存在但 runner、权限、路径或 hash 不一致则阻断。安装器遇到未知 JSON 结构、同名外来分发器或并发编辑时必须拒绝，agent 不得用 `--force` 猜测合并。

在 Orca 管理的 Codex 终端里，当前 `$CODEX_HOME` 是生成态运行时，Orca 会从系统 `~/.codex` 合并用户 Hook。安装器会自动识别这种环境并把 Harness 入口写到 `~/.codex` 源配置；agent 不得直接补丁当前运行时 `hooks.json`、Orca 管理脚本或私有 trust hash。安装后必须创建一个全新的 Orca Agent 会话，让宿主正常镜像源配置，再验证 evidence。

Codex 首次信任用户分发器时，agent 先用一句人话说明：“它不改业务代码，也不是共享 Git hook；只把已登记 worktree 的会话事件交回该仓库自己的门禁，其他仓库不执行。”宿主允许 agent 完成信任复核时自动完成；必须由 UI 确认时，只请用户批准安装器打印出的那一条精确 managed dispatcher，不抛给用户技术选型题。

随后启动一个**全新的 Agent 会话**，完成一次安全的验证闭环。宿主支持创建会话/Agent（例如 Orca）时由当前 agent 自动创建和检查；不支持时才请用户重开一次会话。闭环要让一处可审查的改动经过门禁：

1. 新会话里工作区要有本次任务的改动。工作区干净时，在 `.agents/adoption.md` 的 Log 追加一条接入验证记录。
2. 运行 `harness-kit deliver` 拿到 `accepted`（或者先结束一轮、被 Stop 拦下后再 deliver），然后结束这一轮，让 Stop 再触发一次。
3. Stop 触发之后（下一轮或会话结束后）运行 `harness-kit evidence --repo . --json`。

默认 thin 模式下，Stop 不自己跑检查，而是要求当前改动有匹配的 accepted deliver 戳；每次 Stop 都会记进该会话的 lifecycle 证据。判定标准：

- `lifecycle` 记录了这个新会话的 SessionStart（`sessionStartedAt`）和最近一次 Stop（`lifecycle.stop`）；
- `hookActive: true`：这次 Stop 依据的门禁证据有效，并且 Hook 配置与 SessionStart 时一致。thin 模式下证据是 Stop 接受的 deliver 戳（`lifecycle.evidenceSource: "deliver-stamp"`）；`HARNESS_KIT_STOP_MODE=execute` 时是 Stop 自己跑的 run-checks + verify（`"run-checks"`）。

两者都成立才能宣称 hooks 已生效，不需要为此切换到 execute 模式。`lifecycle.hostSessionId` 是客户端自己的会话 id，用来确认记录来自这次新会话；之后再改文件，`lifecycle.evidenceCurrent` 会变 `false`，但 `hookActive` 仍为 `true`，因为它证明的是 Hook 在这版配置下执行过。`lifecycle` 为 null 说明客户端没执行 SessionStart；`lifecycle.stop` 为 null 说明 Stop 没执行；`stop.decision` 为 `block` 说明门禁正在拦截，deliver 后再结束一轮。干净工作区上的 Stop（`reason: clean`）只证明 hook 被调用，没有改动经过门禁，不能代替上面的闭环。客户端未执行 hooks 时要报 GAP，并用任务开始 SHA 手动跑 `run-checks --base <sha>`，不能把默认 `no-change` 当证据。Stop 模式目前没有项目级配置，execute 只能通过运行 Agent 的进程环境变量 `HARNESS_KIT_STOP_MODE=execute` 开启。

若 `doctor` / `verify` 输出 `install-lifecycle-hooks`、`repair-lifecycle-hooks` 或 `prove-lifecycle-hooks`，这不是给用户看的建议，而是你在宣布接入完成前必须自动收敛的动作。只有安装器发现未知第三方结构，或宿主 UI 必须批准精确的 managed dispatcher 时，才暂停并请用户确认。

原生 Git hooks（pre-commit / pre-push）是**可选且仅限确认安全时**的增强：不得覆盖既有 hooks，不得改变未知的团队工作流，也不能作为首次接入完成条件。

**接入时不改 CI，也不要指示用户修改 CI**：CI 配置属于团队。`harness-kit ci` 是 MR / PR 上的合码门禁，会话 Hook 和 deliver 只是本地快速反馈；它自己从 CI 环境变量找 base，退出码 0 通过 / 1 改动没通过 / 2 配置或环境错误。只有用户明确要求接入 CI 时，才加一个 job，内容如下：
- 完整历史 checkout（GitHub `fetch-depth: 0`，GitLab `GIT_DEPTH: "0"`）；
- Node.js 18+，并装好检查需要的依赖；
- 运行 `npx -y "@erzhe/harness-kit@<版本>" ci`，版本从 `.agents/harness.lock.json` 读。

## 7. 日常维护 / 自愈

门禁发现 drift 后由 agent 处理，人只审查最终变更清单：

1. 生成物 drift → `sync`；它仍然只做确定性重生成。
   升级 Harness 版本用 `upgrade`：先 `upgrade --check`（退出码 2 表示“有可用升级”，不是失败；输出会列出要刷新的 hook runner 和客户端配置），再在干净工作区 `upgrade`。它在同一事务里原位刷新已安装的项目级 hooks，保留第三方条目，不需要再跑 `install-hooks`；只有 linked worktree 里的 Codex 用户分发器例外，按输出的 `install-hooks ... --allow-user-dispatcher` 命令另跑。升级后在**同一会话**里 deliver 并结束一轮即可：会话开始时由旧 runner 记下的 SessionStart，会在新 runner 执行的 Stop 上重新绑定，`hookActive` 照样能证明；只有客户端配置里有第三方 hook 改动时，才需要到新会话里证明。
   upgrade 不改手写文件。manifest 和手写文档里钉着旧版本的命令、旧模板留下的裸 `harness-kit verify`，doctor 会按“文件:行”列出，顺手改掉即可（journal ADR 是历史记录，不检查）。
   删掉模块或注销 knowledge 后，`sync`（或下一次 `upgrade`）会自动删掉它们在 `.agents/.harness-state.json` 里的复核记录，不要手改这个文件。
2. `derived` knowledge stale → 重读绑定的代码/测试/本地配置，有明确证据才原地更新；`policy` 冲突则修代码，语义不清才问用户。verify / deliver 的 NEXT ACTIONS 会给出一条列出全部待复核项的 `record-context-review` 命令，复核完再运行。
3. 契约 drift → 只有需求和代码证据都表明有意变更才 accept，并写进审查清单；否则升级。
4. invariant 违规 → 修代码；确认 policy 已变更后才能改规则。
5. 重跑 `record-context-review`（仅在分析完成后）、`run-checks` 和 `verify` 到绿，列出改了什么、证据、accept 的契约及未动项。
6. 最终汇报按“验证是否通过 / Agent 已自动完成 / 用户仍需做什么 / 仅在什么场景才需验证”分组；不要把总 GAP 数量单独抛给用户判断。

## 反模式

- 手写生成的 `AGENTS.md` / `CLAUDE.md` / `routing.md` / `modules.md`。
- 用 `sync` 或 `record-context-review` 冒充仓库分析。
- 移动/复制业务文档，或按目录名漏掉显式引用文档。
- 为了消灭验证边界发明 capability、glob 或检查。
- 跳过 legacy 快照、逐规则 ledger 或独立盲审。
