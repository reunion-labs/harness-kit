# A CI entry point: `harness-kit ci` as the merge gate

Date: 2026-11-26 (0.9.0)

## Context

Moving the gate from the session layer (SessionStart / Stop hooks) to merge / pull request CI came up while wiring several downstream repositories into CI. CI runs whoever made the change and wherever, and its result sits on the merge request, so an Agent cannot claim it ran.

`run-checks --base <ref>` and `verify` already work without a local deliver stamp, but every caller had to do three things itself:
- find the base from its CI platform's variables;
- make the merge-base computable in a shallow clone;
- chain two commands and combine their exit codes.

## Decisions

1. **One command, `ci`.** It resolves the base, makes the merge-base local, and runs run-checks and verify against that same merge-base (exact mode), the way deliver runs them against the task base.
2. **The base is explicit or comes from the platform, never guessed.** Priority:
   1. `--base`
   2. `HARNESS_KIT_BASE`
   3. GitLab merge request pipelines: `CI_MERGE_REQUEST_DIFF_BASE_SHA`. A merged-result / merge-train pipeline's HEAD is a merge commit on the target, so there `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` comes first (also when there is no diff base).
   4. GitHub `GITHUB_BASE_REF`
   5. The pushed range: GitHub `push` payload `before`, merge queue `merge_group.base_sha`, GitLab `CI_COMMIT_BEFORE_SHA`

   All-zero SHAs (new branch, manual or scheduled pipeline) count as absent. Nothing found is an error: a default such as `HEAD~1` would judge one commit of a multi-commit change and pass silently.
   - `HARNESS_KIT_BASE` is also what run-checks injects into check processes (the resolved base). Reusing the name keeps one meaning, "the base this change is judged against". A nested call sees the merge-base and judges the same change.
   - The pushed range is weaker than a merge request diff: it covers what one push added. It is still the honest base for a post-merge pipeline on the default branch, and the merge request pipeline remains the gate.
3. **History is made complete or the run fails.**
   - A branch base is always fetched into `refs/remotes/<remote>/<branch>`; a commit only when missing.
   - In a shallow checkout the base is fetched with `--depth=50`. Both sides are then deepened (50 / 200 / 1000) and finally unshallowed. Deepening only the base is not enough: a shallow HEAD has no parents, so no merge-base exists even when the base is local.
   - Deepening asks for the HEAD commit by id and falls back to the configured refspecs when the server refuses that.
   - No merge-base afterwards is `shallow-history` or `no-merge-base`.
   - `--no-fetch` uses local history only.
   - Fetches run with `GIT_TERMINAL_PROMPT=0`, so a job fails instead of hanging on a credential prompt. Base values must look like a branch, ref, or commit (no leading `-`, ranges, or refspecs), and every git call is an argument array with `--end-of-options`.
4. **Three exit codes.**
   - 0: passed.
   - 1: the change failed (a check, a blocking gap, or verify).
   - 2: configuration / environment error; the change was not judged.

   A malformed command line and an unexpected crash are also 2. A pipeline can then tell "fix your change" from "fix the CI setup", and a broken setup never reads as either a pass or the author's fault.
5. **No local state.**
   - run-checks gets `record: false`: no manual session, no stored waivers, no evidence. verify gets `recordManualEvidence: false`.
   - ci reads no stamp, task record, or waiver. Local waivers are an Agent's own claim, so a coverage gap waived locally still fails in CI. The fix is a test, or a policy change in the manifest that review can see.
6. **Same judgement as deliver.** Context staleness that already exists on the merge-base is the target branch's maintenance, not this change's failure (`contextBase` = merge-base). Otherwise every merge request would fail until someone refreshed the target branch. Staleness a change introduces still fails, and the post-merge push pipeline catches staleness pushed straight to the default branch. Plain `verify` stays strict. The check budget is unlimited, as in deliver; the CI job timeout bounds it.
7. **One structured report.** `--json` prints a single `ai-harness/ci-report/v1` document:
   - verdict: `status`, `exitCode`, `errorKind`;
   - `base` (source, value, ref, commit, mergeBase, head) and `history` (shallow, fetch outcome, deepened, unshallowed, the git commands it ran, warnings);
   - results: `changed`, selected `checks` with results, `blockingGaps`, and the full run-checks / verify reports.
8. **Examples, not a generator.** `examples/ci/` has a minimal GitHub Actions workflow and GitLab CI job:
   - full-history checkout and Node.js 22 (18+ required);
   - an install step for the repository's own checks;
   - `npx -y "@erzhe/harness-kit@${version}" ci`, with the version read from `.agents/harness.lock.json`, the same pin every other Harness command uses.

   onboarding still does not edit CI: CI configuration belongs to the team.

9. **A changed script selects only a declared check.**
   - Found by running deliver on this repository while building `ci`. The 0.8.1 rule ("a changed file that a runnable capability's `run` names selects that capability") also picked capabilities that are not checks. Here that was a development launcher (`harness: pnpm exec tsx src/cli.ts`): it ran without arguments, printed help, exited 1, and failed the change. In other repositories it could be a release script or a dev server without `background`.
   - Now only capabilities the manifest uses as checks qualify: `modules[].checks`, `validation.gates` / `checksets` checks, and `validation.defaults.no_match` / `always`. A capability whose own script changed, and which is one of those checks, still runs.

## Rejected

- Defaulting to `HEAD~1`, the upstream branch, or `origin/main`: each can pass a change it never looked at.
- Reading the local deliver stamp in CI: the stamp records what an Agent ran locally. The merge gate must judge for itself.
- Adding `--base` to `verify` instead: callers would still combine two commands and two exit codes, and verify would gain a fetch side effect.

## Compatibility

- `ci` is a new public command. The cli-interface snapshot changes (contract `breaking_needs: minor`); no existing command, flag, or JSON field changes. Version: 0.9.0.
- One behavior change (decision 9): a capability that is not used as a check anywhere is no longer selected because its script changed. If a repository relied on that, it should list the capability as a check.
- Downstream repositories need nothing on upgrade; adding the CI job is opt-in.
