---
name: harness-check-loop
description: 在已接入 harness-kit 的仓库里实现需求 / 修 bug 时的「实现 → deliver 验收」闭环。一条 deliver 跑影响面检查 + verify + stamp。
---

# harness-check-loop

目标：**证明这次改动真的交付了**，不是只写完代码。

## 怎么调用 CLI

`harness-kit` 只经 npx 分发，PATH 上通常没有（直接跑会 exit 127）。已接入仓库一律用 `.agents/harness.lock.json` 钉住的版本，与生成的 `AGENTS.md` 里 “Harness CLI” 那一行一致：

```bash
npx -y @erzhe/harness-kit@<lock 里的 version> <cmd>   # 仓库没有 lock 时用 @latest
```

下文的 `harness-kit <cmd>` 都指这条调用；不要为此全局安装。

## 一条命令

```bash
harness-kit deliver --repo .
```

内部固定：解析改动范围 → `run-checks`（影响面 / gates）→ `verify` → 稳定指纹 → **stamp**。

| deliver status | 含义 |
|---|---|
| `accepted` | 可向用户宣布完成 |
| `needs-work` | 按输出修，再跑 deliver |
| `no-change` | 工作区无待验改动（干净） |
| `not-adopted` | 退出码 3：该目录没有 `.agents/manifest.yaml`，harness-kit 不能验收；**不要重跑**，按仓库自身规范验收（NEXT ACTIONS 若列出改动落在的嵌套 target，就对那些 target 逐个 deliver） |

**没有 `accepted`（或干净 `no-change`）就不要说做完了。**

`accepted` 同时打印 `context freshness: ... already stale on task base`（JSON `inheritedContext`）时：这些知识过期在任务 base 上就已存在、本任务没碰它们的输入，所以不阻塞本任务。MAINTENANCE 段给出精确的 `record-context-review` 命令，留给维护者或专门的 Harness 维护任务，不要把刷新塞进业务 diff。本任务改了绑定源、知识文档、manifest 声明或复核记录时，过期仍算本任务的，照常 `needs-work`。

## 改动范围怎么定

1. `harness-kit task-start` 或 `--base <sha>` → 任务范围（含之后 commit）
2. SessionStart（若装了 Hook）会自动记录任务 base
3. 都没有 → **降级为当前工作区 git diff（相对 HEAD）**，对这些文件跑测

不要默认拿 origin/main 乱算范围。

## 闭环步骤

1. （推荐）`harness-kit task-start --repo .`
2. 按 routing / modules 实现；生产代码同步补测试 / gate acceptance
3. `harness-kit deliver --repo .`
4. `needs-work` → 修失败与 blocking gap → 再 deliver
5. `harness-kit evidence --repo .` 看 stamp；`stale` 则回到 3

## 与 Hook 的关系

- **Stop Hook 默认 thin**：没有匹配 stamp 就 block，并提示跑 `deliver`（不要求新开会话）。每次 Stop 都记进该会话的 lifecycle 证据；放行时绑定它接受的 deliver 戳，所以 `evidence --json` 的 `hookActive` / `lifecycle` 能证明门禁真的执行过
- `HARNESS_KIT_STOP_MODE=execute` 时 Stop 内直接重跑验收（兼容旧行为）
- **没装 Hook 也能闭环**：靠 AGENTS 协议 + deliver；Git/CI 再兜底
- 不要把 `hookActive` 当成交付成功标准：交付看 deliver 的 `accepted`，`hookActive` 只说明 Hook 门禁在这个会话里生效过

## 红线

- ❌ 没跑 `deliver` 就说做完了
- ❌ 为消 gap 造假测试或无意义 waiver
- ❌ 用 profile 绕过 validation gate
- ❌ 因「没 SessionStart」去开新会话——那是旧 bug，已修

## 细节命令（通常不必手动拼）

- `plan-checks` — 只算不跑
- `run-checks` — 底层检查（deliver 会调）
- `verify` — 不变量 / 漂移（deliver 会调）
