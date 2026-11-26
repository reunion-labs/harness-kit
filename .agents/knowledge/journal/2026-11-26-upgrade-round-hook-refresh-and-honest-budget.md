# Upgrade-round fixes: in-place hook refresh, same-session proof, honest word budget

Date: 2026-11-26 (0.8.1)

## Issue list (H66–H81)

41 downstream repositories upgraded from 0.7.2 to 0.8.0 (upgrade → install-hooks → doctor / verify / deliver, all ACCEPTED). The new tool issues of 34 of them are collected in a round summary; the raw reports are each repository's report written after 2026-11-26 10:00. Repository labels (repo-A, …) are shared with the other rollout ADRs. They are merged by content and numbered from H66.

| # | Issue | Evidence | Fixed | Why / how |
| --- | --- | --- | --- | --- |
| H66 | The AGENTS.md word budget splits on whitespace, so a Chinese paragraph is one word: 1082 Han characters count as 112 words and the 500-word budget never binds a Chinese repository. | repo-K, repo-AN, repo-W, repo-P, repo-H, repo-O, repo-L, repo-G, repo-AM | yes | Decision 1 |
| H67 | The client-config fallback (`runner \|\| printf block`) blocks every Stop when the runner file is missing or `git rev-parse` fails, ignoring `stop_hook_active`; measured by moving the runner away. | repo-AK, repo-S (measured), repo-AG; listed as not included in 0.8.0 | yes | Decision 2 |
| H68 | `upgrade --check` does not list the hook runner; `upgrade` leaves it pinned to the old version and only prints an install-hooks command, so every upgrade needs a second step. | repo-F, repo-B, repo-G, repo-E, repo-AP, repo-Y, repo-AE, repo-H | yes | Decision 3 |
| H69 | Upgrading and reinstalling in one session mixes runners: SessionStart was recorded by the old runner, the Stop runs the new one, `configurationCurrent=false`, and the session can never prove `hookActive`. | repo-Z, repo-AA, repo-AH, repo-R, repo-AG, repo-J, repo-Y, repo-M, repo-AL, repo-AK, repo-Q | yes | Decision 4 |
| H70 | Deleting a module leaves its review record in the tracked `.agents/.harness-state.json`; sync / doctor / verify / deliver neither report nor clean it, and there is no command to retire it. | 11 repositories (repo-AJ, repo-Z, repo-AA, repo-P, repo-O, repo-I, repo-D, repo-M, repo-AM, repo-AP, repo-AL) | yes | Decision 5 |
| H71 | evidence: top-level `agent` is always `manual`; the stamp hangs on the worktree's old manual record (top-level `createdAt` days old); a deliver the Agent ran from its Bash is not linked to the hook session the deliver output names. | repo-S, repo-W, repo-K, repo-O, repo-AM, repo-AH, repo-R, repo-Z, repo-AG, repo-H, repo-AJ | yes | Decision 6 |
| H72 | verify says "nothing required now" and then prints `WARN manual run-checks evidence no longer matches`; doctor reports a context-freshness ERR with "nothing required now". | repo-Z, repo-F, repo-J, repo-Q; repo-AJ (doctor) | yes | Decision 7 |
| H73 | Harness paths are exempt but select no checks: deleting a harness module silently drops its checks; changing a capability's own script (`.agents/checks/go-test.sh`) does not run it; a Harness-only change without `no_match` is still `no-checks-selected`. | repo-T, repo-S, repo-I, repo-AE, repo-AD, repo-R | yes | Decision 8 |
| H74 | A single upstream string ("a、b、c") renders as a one-entry list after 0.8.0. | repo-AM, repo-AP | yes | A single item stays inline (`Upstream: x`); two or more are one per line. |
| H75 | `upgrade --check` exits 2 when an upgrade is available; scripts with `set -e` treat it as failure. | repo-AJ, repo-AA, repo-AD, repo-A, repo-M, repo-AE, repo-AG | docs + output | Intended contract (current 0 / available 2 / blocked 1). The text output says "exit 2 = upgrade available, not an error"; README, SPEC, and the skill say how to script it. |
| H76 | Hand-written pinned commands (routing `verify` hints, conventions.md) and the 0.7.x `adoption.md` bare `harness-kit verify` never follow an upgrade, and nothing points at them. | repo-H, repo-F, repo-AL | yes | doctor lists them as `file:line` WARNs. upgrade still never edits hand-written files; journal ADRs are skipped as history. |
| H77 | The runner reads stdin with `cat`; a manual probe from a terminal hangs. | repo-R | yes | A TTY stdin is treated as `{}`. |
| H78 | The post-upgrade doctor / verify run with `--details` and print every informational boundary twice. | repo-AK, repo-AO | yes | Human output runs them compact, like a plain run; JSON keeps the details. |
| H79 | The install-hooks warning says the installing session "has no SessionStart", but an old-runner SessionStart existed. | repo-Q | yes | Wording now covers both cases and the rebind of decision 4. |
| H80 | The shell runner only gets `diff_check`, no syntax check. | repo-T | no | doctor requires the runner to be byte-identical to the generator output of this version, which tests execute; a syntax check of a fixed byte string adds nothing. |
| H81 | Round summary item 9: "H19-like bundle omissions still reproduce in 0.8.0". | repo-S, repo-H, repo-Z, repo-K | not reproduced | Those reports use "H19" in repo-F's numbering: the evidence `agent: manual` issue (H71 here). No repository ran prepare-adoption in this round; bundle completeness was fixed in 0.8.0 (H38) and checked on real repository copies then. |

Excluded, not Harness: a report's expectation that modules.md would be regenerated (it was already in sync); zsh not splitting `$HK`; `configurationCurrent=false` after a reinstall being "by design" (now addressed by H69). repo-AD's "verify checks cannot see the task base" was fixed in 0.8.0 (H55: verify injects `HARNESS_KIT_BASE` / `HARNESS_KIT_CHANGED_FILES`).

## Decisions

1. **The word budget is language-neutral.**
   - `countWords` counts each Han or Kana character as half a word (about two characters per English word); everything else splits on whitespace, and only tokens with a letter or digit count (Markdown bullets, `##`, `|` do not). Hangul is space-separated and splits normally; spacing between CJK and other text never changes the count.
   - The budget stays at 150 lines and 500 words of repository content. Surveying the 42 downstream AGENTS.md files with the honest count: 39 exceed 500 and 33 exceed 700; invariant rule text is most of it (e.g. 462 of repo-K's 722).
   - Raising the budget to fit them would make it mean nothing again, so the WARN stays honest. It names the three largest sections, suggests keeping each rule to the sentence an agent must obey and moving rationale into knowledge, and says it is advisory maintenance, not an upgrade step. It never affects verify or deliver.
2. **The outer fallback blocks a turn only once.** The Claude / Codex Stop command is `runner || grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' || printf <block>`. When bash cannot open the runner it never reads stdin, so the fallback still sees the client's re-run marker. Cursor already bounds its loop with `loop_limit`. The 0.8.0 unconditional shape stays recognized as managed, so install-hooks and upgrade replace it in place.
3. **upgrade refreshes the hooks Harness already manages.**
   - Project hook files are repository files: the runner, plus each configured client's project config (`.claude/settings.json`, `.cursor/hooks.json`, `.codex/hooks.json` / `config.toml`). They are rendered with install-hooks' own renderer (`renderAgentHookTargets`) and join the same managed-file transaction as the generated entries and the lock. Third-party entries survive, and a foreign runner is refused.
   - upgrade never installs or removes hooks. `--check` lists the hook files in `changedFiles`, with `hooksChanged` and `hooks.status: refreshed | current | manual`.
   - The linked-worktree Codex dispatcher binds the runner hash in the user directory and the Git admin dir, outside the transaction. That case gets `status: manual` and the exact `install-hooks … --allow-user-dispatcher` command. The 0.8.0 rule "upgrade never touches hooks" was about those cross-boundary files; for repository files it only cost every downstream a second step.
4. **A session refreshed mid-way can still prove the gate.** On Stop, a session whose bound configuration differs from the current one is rebound (`lifecycle.stop.rebound: true`) when both of these hold:
   - The current configuration fingerprint exists. It only does when the runner is exactly this CLI version's managed script, and this Stop runs the CLI that runner pins, so the new configuration is demonstrably executing.
   - The client config minus Harness's own hook entries equals what SessionStart saw. 0.8.1 SessionStarts record `hookForeignFingerprint`; older sessions are compared with the config in the session's base commit.

   A third-party hook edit, an unreadable config, or linked-worktree Codex keeps the old rule (prove it in a fresh session). The pre-upgrade SessionStart still supplies the task base, which is correct: the task started then.
5. **Retired review records are dropped, not hidden.** A review whose context the manifest no longer declares (deleted module, unregistered knowledge) is reported as an advisory `retired-review` and dropped by `sync`, or by the next real `upgrade` in its transaction (alone it never makes `--check` report "available"). A knowledge entry that is still registered but lost its binds stays a blocking orphan review. Dropping a dead record advances no review, so "sync never advances freshness" still holds.
6. **evidence says which session delivered.**
   - A manual record written by a run scoped by a SessionStart task record carries `deliveredIn: { agent, hostSessionId }`. This is attribution, not hook proof.
   - `record.createdAt` is when the evidence was written (it was the manual record file's creation time in 0.8.0); `record.sessionCreatedAt` and the legacy top-level `createdAt` keep the file's creation time. The text output prints `recorded: …` and "run inside claude session … (its task record)".
   - Top-level `agent` keeps meaning "agent of this record" (`manual`), because consumers read it; `record.kind` and `deliveredIn` carry the distinction.
7. **Every ERR has a required next step, and information comes before the verdict.**
   - doctor adds the same `record-context-reviews` / `fix-context-declarations` actions as verify, plus `fix-doctor-problems` for other ERRs.
   - verify attaches its result to the manual evidence before printing NEXT ACTIONS. Stale saved evidence becomes an INFO line there ("deliver refreshes it; verify alone never stamps") instead of a WARN after "READY".
8. **Harness coverage exempts; scripts select.**
   - A change made only of Harness-covered paths is not `no-checks-selected`, because verify is its check.
   - A changed file that a runnable (not mutating, not background) capability's `run` names directly, as a script path or a directory prefix such as `go vet ./.agents/checks/snapshot`, selects that capability (`reason: script:<path>`).
   - The docs say plainly that a harness module with checks must stay; only pure coverage modules can go.

## Compatibility and upgrade

- **Contracts.** No CLI flag or help text changed (the cli-interface snapshot is unchanged), and the manifest schema is unchanged.
- **JSON changes are additive except one value.**
  - Added: upgrade `hooks`, with `hooksChanged` now possibly `true`; evidence `record.deliveredIn` / `record.sessionCreatedAt`; lifecycle Stop `rebound`; validation evidence `deliveredIn`; session `hookForeignFingerprint`; context-freshness code `retired-review` (advisory); plan check reason `script:<path>`; nextAction `fix-doctor-problems`.
  - Changed: `record.createdAt` (added in 0.8.0) now means the evidence time.
- **Behavior changes.**
  - upgrade rewrites managed hook files.
  - sync may drop retired review records.
  - A capability whose script changed now runs; a Harness-only change no longer needs `no_match`.
  - doctor's budget WARN appears for most Chinese repositories (advisory).
  - Single dependencies render inline, so AGENTS.md / modules.md change where they had one item.
- **Version.** Fixes and in-scope improvements with no contract break: 0.8.1 (patch).
- **Upgrading a repository on 0.8.0:**
  1. `npx -y @erzhe/harness-kit@0.8.1 upgrade --repo . --check` (exit 2 = upgrade available), then `upgrade --repo .` on a clean tree. It rewrites the lock and, where they change, AGENTS.md / modules.md (single dependencies inline). It also refreshes the hook runner and client configs (guarded fallback) and drops retired review records.
  2. In the same session, `deliver` and finish the turn: the Stop through the new runner rebinds the session, so `hookActive` is proven without a new session unless the client config has third-party hook edits.
  3. Commit the changed files.
  4. Only for linked-worktree Codex: run the `install-hooks … --allow-user-dispatcher` command upgrade prints.
  5. Advisory, in a later maintenance task: doctor's budget WARN (shorten invariant text) and hand-written pins it lists.
