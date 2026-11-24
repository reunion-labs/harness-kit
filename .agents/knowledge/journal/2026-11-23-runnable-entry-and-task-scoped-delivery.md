# Runnable entry commands, inherited freshness, and not-adopted delivery

Date: 2026-11-23

## Decisions

1. **Entry commands pin the lock version.** harness-kit is distributed through npx, so a bare `harness-kit` is usually not on PATH (exit 127). Generated `AGENTS.md` writes every runnable instruction as `npx -y @erzhe/harness-kit@<version from .agents/harness.lock.json> <cmd>`, the same form as the lifecycle Hook runner, and `@latest` when there is no lock. `deliver` / `verify` / `doctor` / `evidence` / Stop-hook messages use the same invocation. `render` stays pure: callers read the lock and pass the version in. `upgrade` renders with its target version in the same transaction that writes the lock. The shared `GEN_HEADER` comment is unchanged because it marks every managed file. The documented `harness-kit task start` never existed (commander rejects the extra argument), so entries now say `task-start`.
2. **deliver separates inherited context staleness.** A freshness verdict depends only on the manifest declaration, the recorded review, and the bytes of the knowledge target and its bound sources. If none of those inputs differs between the task base and the current tree, the same blocking issue already existed on the base. In that case `deliver` (and execute-mode Stop) reports it as `inheritedContext` plus a recommended maintenance action with the exact `record-context-review --path|--module` command, and does not block acceptance. If there is any doubt (no manifest on the base, an unreadable base, or a different declaration or review record), the issue stays task-scoped. Plain `verify` stays strict so CI can still stop the commit that introduced the staleness.
3. **Unadopted directories are a distinct outcome.** If the requested directory has no `.agents/manifest.yaml`, `deliver` first looks for Harness targets around it. An enclosing target turns the result into `needs-work` with a command to re-run at the target root. Otherwise the result is `not-adopted`, with exit code 3, `adopted: false`, and any changed nested targets listed. It records no evidence. The next step is to validate with the repository's own conventions, not to re-run deliver.

## Why

These came from real Agent sessions. Eight tasks lost their accepted stamp because entry commands were not runnable. Mainline dependency bumps on bound files made every unrelated task `needs-work`. An unadopted repository answered `NEEDS-WORK` plus "re-run deliver", which made Agents loop.

## Boundaries

- With implicit worktree scope (no `task-start`, base = HEAD), anything already committed counts as base. This matches how run-checks treats the same scope. Use `task-start` so that committed task work stays attributed to the task.
- A plain `verify` run after `deliver` still records its strict verdict on manual evidence. Re-run `deliver` for task acceptance.
- Binding JSON sub-paths (for example `package.json#/scripts`) would change the manifest schema and is left for a separate change.
