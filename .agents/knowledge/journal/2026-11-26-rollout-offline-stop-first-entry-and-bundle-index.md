# Rollout fixes: offline-safe Stop, audited first entry, self-describing bundle

Date: 2026-11-26 (0.8.0)

## Issue list (H36–H65)

Batches 3–6 onboarded or upgraded about 45 downstream repositories with 0.7.1 and 0.7.2. Their reports again numbered new issues independently (several reused H18–H39 for different things), so the list below merges them by content and continues from H36. Each repository's report has a tool-issue section, and a rollout summary collects them; repository labels (repo-A, …) are shared with the other rollout ADRs.

| # | Issue | Evidence | Fixed | Why / how |
| --- | --- | --- | --- | --- |
| H36 | Without the CLI (registry or npx unreachable) the Stop runner blocks every Stop, a clean read-only session included, ignores `stop_hook_active`, and loops. | repo-M t2 (its fourth audit round); repo-N t1 (~10 consecutive blocks); repo-D t3; repo-O t2 (H10 everywhere) | yes | Decision 1 |
| H37 | A repository without legacy entries: plain `sync` writes AGENTS.md / CLAUDE.md before any audit. Only the skill forbade it. | repo-P t3; repo-Q t1 | yes | Decision 2 |
| H38 | The bundle lacks `.agents/harness.lock.json` (cited by the generated entry), `.agents/.harness-state.json`, `.agents/adoption/**`, hooks, `.claude/settings.json`, and non-`.agents` onboarding files such as `.prettierignore`; auditors cannot check them. | repo-R t1, repo-S, repo-T, repo-U, repo-V, repo-W, repo-X, repo-Y, repo-Z, repo-AA, repo-AB, repo-AC, repo-AD, repo-AE, repo-AF | yes | Decision 3 |
| H39 | A bare path mention followed by CJK punctuation (`knowledge/templates/action.md、`) is neither guidance nor unresolved: the regex accepted only ASCII boundaries. | repo-M t2 | yes | Decision 4 |
| H40 | `unresolved` lists a host name (shaped like `api-sg-edge.example.org`) as a path mention, because `.org` is also an Org-mode extension. | repo-AB t2 | yes | Decision 4 |
| H41 | Inventory follows only AGENTS.md / CLAUDE.md; other clients' always-on rules (`.cursor/rules/*.mdc`) reach the bundle only if registered by hand. | repo-AD t1 | yes | Decision 4 |
| H42 | `evidence --json`: top-level `hookConfigurationCurrent: false` beside `lifecycle.configurationCurrent: true`; top-level `agent` is always `manual`; `lifecycle.session` is an opaque hash. | repo-AD, repo-O, repo-AG, repo-W, repo-AE, repo-K t3, repo-AH t2, repo-H t3, repo-AI, repo-S, repo-AJ, repo-AK | yes | Decision 5 |
| H43 | `.claude/settings.json` from install-hooks belongs to no module: an `unmapped-file` advisory forever, and blocking under `required_coverage: ["**/*.json"]`. | repo-AB t2; repo-AA t2 | yes | Decision 6 |
| H44 | `required_coverage: ["**/*.go"]` hits Go check programs under `.agents/`; with no negation, repositories add a harness-checks module. | repo-AE t2; repo-Z t2 | yes | Decision 6 (no `!` syntax added) |
| H45 | `record-context-review --path` only accepts the manifest spelling; `.agents/knowledge/domain.md` fails as "not declared" with no hint. | repo-AB t2 | yes | Decision 7 |
| H46 | Lifecycle proof is bound to the worktree fingerprint: any edit after the last Stop shows `DEGRADED … stale` until a new session. | repo-AB t2; repo-R t2 (after reinstall) | yes | Decision 5 |
| H47 | Freshness is byte-based: one comment line in a bound file means NEEDS-WORK and one review command per item; a domain.md bound to 31 files triggers on almost every change. | repo-AL t2; repo-AK t2 (H19); repo-AA t2 (manifest as module entry) | partly | Decision 7. Byte freshness stays; the cost is cut instead. |
| H48 | The 700-word AGENTS.md budget is tight for rule-heavy repositories; spaces between CJK and English count as extra words. | repo-AF t2 (697), repo-P t3 (698), repo-Q t1, repo-R t1, repo-N t1, repo-AH t1 | yes | Decision 8 |
| H49 | AGENTS.md renders invariants without their id, though scope / routing / module cards refer to rules by id. | repo-R t1/t2, repo-AK, repo-T, repo-X, repo-AA, repo-AM | yes | Decision 8 |
| H50 | Upstream / Downstream are comma-joined; items containing `;` or `,` run together. | repo-AC t1 | yes | Decision 8 |
| H51 | verify FAILED on context freshness, yet NEXT ACTIONS says "nothing required now"; deliver only says re-run. | repo-AK t2 (H18) | yes | Decision 7 |
| H52 | A newly installed project hook is not run in the installing session (no lifecycle), while other reports saw it hot-loaded (old H19). | repo-AG t1; repo-W t2 | docs + message | Client behavior, not ours. install-hooks and the skill now say both happen; prove `hookActive` in a fresh session. |
| H53 | `upgrade` leaves the runner pinned to the old version; doctor then says "not a managed executable runner", which reads like corruption. | repo-H t3 (H25); repo-R t2; repo-G t2 | yes | Decision 9. upgrade still never rewrites hooks. |
| H54 | A task record left by an earlier session or probe is reused silently; deliver includes already-committed history. | repo-H t3 (H26); reproduced in this repository (base 3ddecbe from the previous session) | yes | Decision 10 |
| H55 | `verify` does not inject `HARNESS_KIT_BASE` / `HARNESS_KIT_CHANGED_FILES` into invariant checks, so "changed files only" rules differ between verify and run-checks. | repo-AI t2 (H37); repo-S t2 | yes | Decision 10 |
| H56 | The skill puts `accept-contract` after the audit, but contract baselines are landing evidence, so the receipt goes stale; prepare-adoption gives no warning. | repo-AI t2 (H38); repo-S t2 | yes | Decision 3 (preconditions) + skill order |
| H57 | The init template for `.agents/adoption.md` still says bare `harness-kit verify`. | repo-G t2; repo-K t3; repo-D t3 | yes | New scaffolds only; existing hand-authored files are left alone. |
| H58 | `nextActions[].reason` still says "use harness-kit deliver". | repo-L t3 | yes | Reasons use the pinned invocation. |
| H59 | The starter `diff_check` (`git diff --check`) never sees untracked files, and says nothing. | repo-AN t3 (H37) | docs | The starter `desc` states it; a correct untracked-file variant is too clever for a starter command. |
| H60 | `identity.upstream/downstream` render as the AGENTS.md "Dependencies" list and clash with "no downstream lists" principles. | repo-AN t3 (H36); repo-Z t2; repo-AF t2 | docs | Skill conflict section |
| H61 | Without legacy entries, rules live in commit messages of *all* branches; the onboard inventory did not say so, and task workspace mirrors sync only the base branch. | repo-AJ t2 (H18); repo-AM t2 | docs | Skill §1 |
| H62 | Self-written check scripts turn the blind audit into an adversarial loop (5 fail rounds, 83 probes). | repo-V t2 (H18); repo-W, repo-AG, repo-Y | docs | Skill §4.4: acceptance standard "core cases of the rule + declared Limits". |
| H63 | After the takeover, `prepare-adoption` refuses ("legacy evidence is stale"), so a post-takeover re-audit cannot get a candidate. | repo-Y t2 | yes | Decision 3 |
| H64 | A blind-audit sub-agent keeps running after reporting and later overwrites the report with a different verdict. | repo-Y t2 | docs | Host behavior. The receipt already binds the report hash; the skill says to bind the final file you read. |
| H65 | A legacy "review fingerprint + probe" mechanism with pending items: adding a fresh fingerprint resets the probe. | repo-AO t1 (H25); repo-AH t1 | docs | Skill conflict section |

Not addressed this round:

- **H10 remainder**: the runner still starts `npx` per event. `--prefer-offline` removes the registry round trip once the pinned version is cached; a resident cache or binary is a separate design.
- **H11** (shared `core.hooksPath`) stays a deliberate refusal. **H6** (Stop for subdirectory targets) is unchanged.
- **A missing runner file** still makes the outer client command block on every Stop. That is a broken install (the runner and the client config are committed together), not an outage; doctor reports it. Making the outer command loop-aware would need a new recognized command shape for no reported case.
- **Negated globs in `required_coverage`** were not added. The reported case (H44) is solved by decision 6, and include-only globs keep the coverage auditable.
- Host and environment items, not Harness: sub-agents cannot write report files; instruction-shaped filtering of replies that mention `.claude/settings.json`; `claude -p --allowedTools` swallowing the prompt; nested `claude -p` needing `env -u CLAUDECODE`; Go toolchain and linker flags (`-checklinkname=0`); gofmt version drift; zsh word splitting of `$HK`; `rm -rf` denied by policy; 429 quota interruptions; a third-party deployment CLI editing `.gitignore`; Python without ensurepip; `GOCACHE` size; `go run dir/main.go` argument parsing; the `claude -p` stdin warning; the home directory being a symlink; `git ls-files` quoting non-ASCII paths.
- Already fixed in 0.7.2 and only re-observed: H1 residues in generated files, the contracts heading (H22/H27), the hot-load install warning, and "thin Stop only accepts its own session's stamp" (repo-N t1, fixed by H26).

## Decisions

1. **Stop never loops, and an outage never blocks a clean worktree.**
   - The runner reads the hook payload first, then pipes it to the CLI, so it can still read the client's own re-run marker if the CLI cannot run.
   - When the CLI fails, a Stop on a clean worktree (`git status --porcelain --untracked-files=all` empty) is allowed with a notice. Claude Code receives a `systemMessage`, Cursor `{}`, Codex nothing on stdout. A dirty worktree is blocked once. The Stop the client re-runs because of that block (`stop_hook_active: true`, or Cursor `loop_count > 0`) is allowed with a "not verified" notice. Committed but undelivered work is invisible to the runner and is judged by the next Stop that can run the CLI.
   - The marker is matched in the host's JSON text. A quoted marker inside a message string is escaped JSON, so it does not match; a test covers this.
   - With the CLI, every path that would block (thin no-stamp and scope errors, execute without SessionStart, execute check failures) first checks a per-session stop guard. If the client is re-running Stop (`stop_hook_active` / `loop_count`) and the change fingerprint equals the last blocked one, the Stop is allowed as lifecycle `reason: loop-exit`. Any change blocks again, so a working agent is still gated. The guard lives at `<git-admin>/harness-kit/validation/stop-guard-<token>.json` (24-hour expiry), independent of SessionStart, because hooks loaded mid-session have no session record.
   - `loop-exit` clears gate evidence and makes the hook state DEGRADED. The block message says plainly that an unchanged change is not blocked twice in a row, and that the agent must then report the change as not verified. This is the trade-off: a gate that loops forever is worse than one that blocks once and leaves a visible, recorded exit.
   - The runner calls `npx --prefer-offline`. The version is pinned, so cached bytes can never be stale.
2. **The first AGENTS.md is the audited end of onboarding.**
   - When AGENTS.md does not exist, plain `sync` refuses in the transaction preflight (zero writes). Two ways through: `--adopt-existing` with a pass receipt, or `--create-entry`.
   - `--create-entry` is the explicit confirmation for a new repository. It refuses when any agent guidance exists anywhere (legacy entries, nested entries, other clients' rule files; a `CLAUDE.md -> AGENTS.md` alias does not count). It cannot be combined with `--adopt-existing`.
   - Daily `sync` is unchanged once AGENTS.md exists. `upgrade` never creates the first entry; it skips AGENTS.md and a missing CLAUDE.md and says so in `notes`.
   - `init` now prints both paths. The quick start `init → sync` becomes `init → sync --create-entry`: a CLI behavior break, hence 0.8.0 (see Compatibility).
3. **The bundle carries the whole onboarding diff and says what it does not carry.**
   - Landing now includes `.agents/harness.lock.json` (the generated entry cites it) and `.agents/.harness-state.json`. They are stable during onboarding, because reviews are recorded before prepare. `.agents/adoption/**` stays excluded (the index and snapshots are already bound under `source/` and `legacy/`), and so does `.agents/hooks/` (the gate is installed last).
   - New `worktree` evidence covers paths outside `.agents/` that differ from HEAD and no other evidence covers, e.g. `.prettierignore`. Files are bound by bytes and mode, symlinks by target, deletions by path, and all are re-discovered and compared at apply. It is empty without a HEAD commit or outside Git. Non-file changes (submodules) fail closed with "commit or revert it".
   - `INDEX.md` maps every repository path to its artifact and lists what is absent by design. It is bound like every other artifact (`index` in `candidate.json`).
   - Candidates without `worktree` (before 0.8.0) are rejected with a re-prepare message. In-flight candidates must be prepared again anyway, because the lock version they render changes.
   - `prepare-adoption` warns, in text and JSON `preconditions`, about landing steps that would stale the receipt if done after the audit: snapshot contracts without a baseline, pending context reviews, hooks already installed. The skill moves `accept-contract` before prepare (H56).
   - After the takeover, an index entry whose live file is Harness output, and whose snapshot still matches the index, counts as intact legacy evidence. That lets a re-audit prepare a candidate (H63). A tampered snapshot is still stale.
4. **Guidance discovery sees what agents actually load.**
   - Other clients' always-on rule files are guidance roots at any depth, followed for references, never snapshotted or taken over. The list: `.cursorrules`, `.cursor/rules/**`, `.windsurfrules`, `.windsurf/rules/**`, `.clinerules` (file or directory), `.roorules`, `.roo/rules/**`, `GEMINI.md`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `.junie/guidelines.md`.
   - Paths stay ASCII. Every other character is a boundary, including CJK text and punctuation, Markdown emphasis and quotes. A sentence-ending period is a boundary unless the name continues. Supporting CJK file names would turn `见docs/x.md` into one bogus path, which is the more common case.
   - An unresolved mention whose first segment is a host name with at least three labels is a scheme-less URL and is dropped. A real file of that name still resolves.
5. **Hook proof is about the hook, not the latest edit.**
   - `lifecycle.active` (and therefore `hookActive` and ACTIVE) requires: the configuration is unchanged, and the gate evidence *passed when the Stop accepted it* (`evidencePassed`). Later edits only set `evidenceCurrent: false`. `evidenceValid` keeps its 0.7.2 meaning (passed and current).
   - The next change is judged by the next Stop, so no one has to start a new session to clear a stale-looking proof.
   - evidence adds a `record` object (`kind: manual-deliver | lifecycle`, session, agent, hostSessionId, createdAt) that names what the top-level `session` / `agent` / `createdAt` describe. Top-level `hookConfigurationCurrent` now follows the hook proof: it equals `lifecycle.configurationCurrent` when a lifecycle session exists. It used to read `false` for every manual record. `lifecycle.hostSessionId` is the client's own session id.
6. **Harness-managed paths are covered by verify.** These paths are never `unmapped-file` or `unmapped-required-file`, because `verify` judges them and deliver always runs verify: `.agents/**` (check scripts and programs included), `AGENTS.md`, `CLAUDE.md`, and the client hook configs install-hooks writes (`.claude/settings.json`, `.cursor/hooks.json`, `.codex/hooks.json`, `.codex/config.toml`). A module may still own them to add checks; `no_match` still fires when nothing matched a module. This also removes H44's reason for negated globs.
7. **Freshness stays byte-exact; its cost and its next step are explicit.**
   - A comment can change what a document claims, so there is no semantic diffing.
   - `record-context-review` accepts the on-disk spelling (`.agents/<path>`, `./`, trailing slash, absolute path inside the target). `--path` / `--module` are repeatable, and the command records one review for several contexts in one state write; any bad selector writes nothing and lists the reviewable names.
   - verify and deliver add a required `record-context-reviews` action with one combined command for every task-owned stale item, plus `fix-context-declarations` for missing sources and orphan reviews. A failing verify with no other required action gets `fix-verify-failures`. The skill says to bind only the files a document really describes, and not to make `.agents/manifest.yaml` a module `entry`.
8. **AGENTS.md: ids, one dependency per line, and a budget on what the repository controls.**
   - Invariants render as `` - `id`: rule [enforced|checked|manual] ``. Upstream / downstream render one item per line in AGENTS.md and modules.md.
   - doctor's word budget is 500 words of repository content. The fixed generated header, Working agreement, and Knowledge & maps (about 300 words, identical everywhere) are excluded. The 150-line limit is unchanged.
   - `countWords` ignores whitespace next to CJK text, so spacing between Chinese and English no longer adds words. Before, the limit was 700 words in total with about 400 left for content; the new limit gives that content roughly 100 more words, enough for the ids.
9. **upgrade names the hook refresh.** upgrade still never rewrites hooks, because they span the repository, the Git admin dir, and user directories. When hooks are configured, it adds the exact `install-hooks --repo . --stop --agents <configured>` command to `notes` and prints it. doctor reports an older managed runner as "pinned to @erzhe/harness-kit@<old> (running <new>); re-run install-hooks", which is still DEGRADED, but no longer reads as a damaged file.
10. **Checks and deliver see the same task.**
    - `verify` gives invariant and contract `check` commands the same `HARNESS_KIT_BASE` / `HARNESS_KIT_CHANGED_FILES` as run-checks. The base is the task base for deliver and execute Stop, and the task record or HEAD for plain verify. Outer values are scrubbed. Snapshots get no change list: they must fingerprint the whole interface.
    - deliver reports its task record (JSON `task`, plus origin in text) and `taskWarnings` when the record is older than 7 days or its base is not an ancestor of HEAD.

## Compatibility and upgrade

- **Contract impact.** cli-interface (breaking → minor) changes in three ways: plain `sync` no longer creates a missing AGENTS.md; `sync --create-entry` is new; `record-context-review --path/--module` are repeatable. The manifest schema is unchanged. Version 0.8.0.
- **JSON changes are additive except one value.**
  - Added: evidence `record`, `lifecycle.hostSessionId` / `evidencePassed` / `evidenceCurrent`; deliver `task` / `taskWarnings`; prepare-adoption `worktreeEvidenceCount` / `preconditions`; candidate `worktree` / `index`; record-context-review `reviews`; new nextAction ids `record-context-reviews`, `fix-context-declarations`, `fix-verify-failures`; lifecycle Stop reason `loop-exit`.
  - Changed: evidence top-level `hookConfigurationCurrent` now follows the lifecycle proof instead of being `false` for every manual record.
- **Behavior changes.**
  - `hookActive` / ACTIVE no longer drop after a later edit.
  - Plan fingerprints change for diffs touching Harness paths (no more unmapped gaps), so stamps taken with 0.7.2 are stale after the upgrade; that already happens because the generated entries change.
  - The runner script changes, so installed hooks show DEGRADED until reinstalled.
- **Upgrading a repository on 0.7.2:**
  1. `npx -y @erzhe/harness-kit@0.8.0 upgrade --repo . --check`, then `upgrade --repo .` on a clean tree. AGENTS.md is rewritten (invariant ids, dependency bullets, lock pin), modules.md too when modules declare upstream/downstream, and the lock moves to 0.8.0.
  2. If hooks are installed, run the `install-hooks --repo . --stop --agents <clients>` command upgrade prints, `deliver`, and prove `hookActive` in a fresh session.
  3. Commit the changed files.
  4. Optional cleanup: a module that existed only to cover `.agents/checks/**` or `.claude/settings.json` can go. A hand-written `harness-kit verify` line in `.agents/adoption.md` can be edited. doctor's budget line now shows repository-content words.
  5. Automation that ran `init → sync` on a new repository must add `--create-entry`. Existing repositories go through prepare → blind audit → `sync --adopt-existing`.
  6. An adoption in flight on 0.7.2 must run `prepare-adoption` again with 0.8.0 into a new empty directory and be re-audited.
- Released as 0.8.0 (minor).
