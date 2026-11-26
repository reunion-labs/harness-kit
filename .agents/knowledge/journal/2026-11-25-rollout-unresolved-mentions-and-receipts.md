# Rollout fixes: unresolved mentions, receipts without legacy entries, smaller entry template

Date: 2026-11-25 (0.7.2)

## Issue list (H18–H35)

Twelve downstream repositories were onboarded or upgraded with 0.7.0/0.7.1. Their reports numbered new issues independently, so the same number means different things in different reports. The list below merges them by content and renumbers from H18. Each repository's onboarding report has a tool-issue section; repositories are labeled repo-A, repo-B, … (the same label means the same repository in every rollout ADR).

| # | Issue | Evidence | Fixed | Why / how |
| --- | --- | --- | --- | --- |
| H18 | Guidance closure fails closed on any unresolved bare path, which blocks adoption outright. In repo-A, 46 bare mentions were unresolved, with no exclusion config. | repo-A turn-1 (H18) and its guidance-resolution notes | yes | Decision 1 |
| H19 | Claude Code hot-loads a newly installed project Stop hook into the running onboarding session, so every turn ends blocked while an async audit is pending. | repo-B turn-1 (H18), repo-C turn-1 (H18) | yes (docs + install warning) | Decision 5. We do not add "allow while legacy entries are pending": that would weaken the gate. |
| H20 | `init` starts from a JS template (pnpm, `src/**` console.log), and still lacks `no_match` (old H4). | repo-C turn-1 (H19); H4 in every report | yes | Decision 4 |
| H21 | A repository without legacy entries has no audit-before-write guard. `sync --adopt-existing` returns early and never checks the receipt. | repo-B turn-1 (H19); repo-D turn-1 (side finding of its H14) | yes, for `--adopt-existing` | Decision 2. Plain `sync` stays receipt-free, so the `init → sync` path for new repositories keeps working. |
| H22 | The fixed Working agreement (~290–320 words) eats most of the 700-word AGENTS.md budget. The two task-start lines disagree ("Prefer" vs "Optional"). | repo-E turn-1 (H18), repo-F turn-1 (H18), repo-G turn-1 (H18), repo-H turn-2 (H18), repo-I turn-2, repo-D turn-1 (H17) | yes | Decision 3 |
| H23 | Capabilities cannot see the task base, so "check changed code only" needs a hash baseline of legacy files. | repo-E turn-1 (H19) | yes | Decision 6 |
| H24 | The `evidence` top-level `agent: manual` / `hookConfigurationCurrent: false` sits next to `hookActive: true`, and readers misread it. | repo-F turn-1 (H19); repo-G, repo-J, repo-H, repo-I, repo-K turn-2 | yes | Additive `hookActiveSource` field plus clearer text output |
| H25 | `identity.scope_out` always renders as "Out of scope (do NOT modify here)", so pointer facts read as prohibitions. | repo-G turn-1 (H20) | docs only | The rendering states what the field is for. The skill and SPEC now say: only things this repository must not modify. |
| H26 | A worktree-scope deliver stamp from before SessionStart is rejected after it, even with the same base and files. | repo-H turn-2 (H21) | yes | Root cause: `startValidationSession` moved the manual latest pointer to an empty session. It no longer does. |
| H27 | The AGENTS.md contracts heading ("need a version bump") and the drift hint ("bump version") assume a versioned interface. | repo-H turn-2 (H22) | yes | The heading is now "never break silently". The drift hint mentions `breaking_needs` only when declared. |
| H28 | SPEC does not state that `forbid_pattern` is a per-line, flag-less JS RegExp, or that `path_glob` uses fast-glob `dot:false`. | repo-H turn-2 (H23) | docs | SPEC §3 now documents the exact scan semantics, verified against `src/enforce.ts` and fast-glob. |
| H29 | The skill does not require snapshot/check/binds descriptions to match their real coverage. | repo-H turn-2 (H24) | docs | Skill §3.4 now requires this. |
| H30 | H1 residue: bare `harness-kit` appears in the generated header, the settings.json and runner failure fallbacks, and the doctor/verify/deliver/upgrade/run-checks hints. | repo-L turn-1 (H18) and turn-2; repo-B, repo-F, repo-G, repo-H, repo-I, repo-E, repo-C, repo-K | yes | Decision 3 (header); runtime hints use the lock-pinned invocation |
| H31 | The Stop block message says `deliver --repo .`; run from a nested target's directory, it accepts the wrong target. | repo-D turn-2 (open item 4) | yes | The message names the gated root's absolute path. |
| H32 | H17 widened: a module `role` that recites directories, the optional module upstream/downstream graph, and knowledge `binds` also clash with "zero lists" principles. | repo-L, repo-E, repo-C turn-1 (H17) | docs | The skill's conflict section covers all three. |
| H33 | `.agents/.harness-state.json` must be committed, or verify fails in a fresh clone. Onboarding never said so. | repo-C turn-1 (H15, r2) | docs | Skill §4.1 |
| H34 | A parent target's prepare-adoption treats a nested target's generated `CLAUDE.md` stub as legacy, then fails on its target-relative references. | repo-D turn-1 (H14), left open in 0.7.1 | yes | Decision 1 (exact stub recognition, ancestor fallback) |
| H35 | `deliver --repo <nested target> --json` reports the enclosing root's stamp. | repo-D turn-1 (H16), left open in 0.7.1 | yes | `inspectDeliveryStamp` / `coveringStampEvidence` key by target, not by Git root. |

Not addressed this round:

- **H10** (the runner ignores `stop_hook_active` and runs `npx` per event). It needs a runner caching/offline design.
- **H11** (shared `core.hooksPath`) is deliberate refusal.
- **H6** (Stop for subdirectory targets).
- The flaky `npm test` in repo-A is not a Harness issue.
- Re-review after a module `entry` changes is intended freshness behavior.

## Decisions

1. **Only bare path mentions may stay unresolved, and the list is bound.**
   - References are classified as Markdown links, `@path` imports, or bare path mentions.
   - Links and imports resolve as before: source directory, then target root. A missing or outside-repository link or import still fails closed.
   - Mentions additionally try each intermediate ancestor directory, nearest first. Skill and package documents usually write paths relative to their own root. The first two bases keep priority, so no earlier resolution changes.
   - A mention that names no in-repository file becomes an `unresolved` entry (`source`, `reference`, `kind`, `reason: missing | outside-repository`) in the candidate metadata. The entry is covered by the candidate hash, re-discovered and compared at apply time, and must be confirmed by the blind auditor.
   - An existing but unsafe target (binary, special file, symlinked directory, symlink outside the repository) still fails closed whatever the syntax.
   - No exclusion config was added. An unresolved mention has no bytes to exclude. Over-inclusion of resolvable documents is harmless. An exclusion list would itself need auditing.
   - On the repo-A copy, the closure stays at 30 files. 13 of the 46 mentions remain unresolved; the rest resolve through ancestors. prepare, audit receipt, and `--adopt-existing` all succeed.
   - Generated output is recognized by one helper, `isHarnessGenerated`: a file that starts with the marker, or the **exact** `CLAUDE.md` stub. This prevents descent into nested targets. It also keeps older-header stubs managed, which the header change in decision 3 depends on.
   - Candidates from 0.7.1 lack `unresolved`; they are treated as an empty list. 0.7.1 threw on any unresolved reference, so such a candidate cannot have hidden one.
2. **`--adopt-existing` always proves the receipt.**
   - It requires `--candidate` and `--audit`.
   - Whenever the transaction would write a target, the full receipt check runs, even with zero legacy entries.
   - A pure no-op (every target already current) skips the check, so re-running a finished takeover is harmless.
3. **A smaller, version-free-header entry template.**
   - The Working agreement keeps every rule in about 220 words. A test caps it at 240 and checks that task-start appears once.
   - `GEN_HEADER` no longer names a bare command. It stays version-free, because a pinned version in the header would rewrite every generated file on each upgrade.
   - The hook fallback in client configs cannot know the lock version, so it points at the pinned command in AGENTS.md. The 0.7.1 wording stays recognized as managed, so a reinstall replaces it in place.
4. **`init` detects the stack.**
   - `go.mod` → Go commands; `Cargo.toml` → cargo; `package.json` → package manager from the lockfile plus scripts that really exist (npm's placeholder test script is skipped); otherwise only `diff_check`.
   - The `src/**` JS invariants appear only for a Node repository that has `src/`.
   - Every starter declares `diff_check` (`git diff --check ${HARNESS_KIT_BASE:-HEAD}`) and `validation.defaults.no_match: [diff_check]`, so a fresh starter is deliverable (old H4).
5. **Install hooks last.**
   - The skill makes the session gate the final onboarding change and requires an immediate `deliver`.
   - `install-hooks` warns that Claude Code may hot-load the hooks into the installing session.
6. **Checks see their change.** `run-checks` injects `HARNESS_KIT_BASE` (resolved base commit; unset without one) and `HARNESS_KIT_CHANGED_FILES` into each check process. The second names a private temp file listing target-relative changed paths, deleted ones included, and is removed afterwards. Outer values of both are scrubbed.

## Compatibility

- No CLI flag was added or removed, and the manifest schema is unchanged. JSON changes are additive: prepare-adoption `unresolvedReferenceCount` / `unresolvedReferences`; candidate `unresolved`; evidence `hookActiveSource`.
- Behavior changes:
  - `sync --adopt-existing` without `--candidate` now errors, even when there is nothing to adopt.
  - Every generated file changes once, because of the header and template.
  - The installed hook fallback text changes after reinstall.
  - A SessionStart no longer hides an earlier stamp that still covers the change.
- Released as 0.7.2 (patch): rollout fixes with no contract break.
