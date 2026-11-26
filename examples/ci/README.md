# CI merge gate examples

`harness-kit ci` is the gate that runs on every merge / pull request, whoever made the change and wherever. Its result is the CI job's status on the merge request, so nobody (Agent or human) can claim it ran. `deliver` and the SessionStart / Stop hooks stay the fast local feedback loop; `ci` is what the merge waits for.

- [`github-actions.yml`](github-actions.yml): GitHub Actions workflow (pull requests and pushes to `main`).
- [`gitlab-ci.yml`](gitlab-ci.yml): GitLab CI job (merge request pipelines and pushes to the default branch).

Both check out the full history, set up Node.js 22 (harness-kit needs 18 or later), install the repository's own dependencies (run-checks executes its test / typecheck capabilities), and call the CLI pinned to the version in `.agents/harness.lock.json`.

## What `ci` does

1. **Base.** The first of these that is set:
   1. `--base <ref>`
   2. `HARNESS_KIT_BASE`
   3. GitLab merge request pipelines: `CI_MERGE_REQUEST_DIFF_BASE_SHA`, or `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` (also used first in merged-result / merge-train pipelines, whose HEAD is a merge commit on the target)
   4. GitHub `pull_request` / `pull_request_target`: `GITHUB_BASE_REF`
   5. The pushed range: the `before` of a GitHub `push` event, the `merge_group.base_sha` of a GitHub merge queue, or GitLab `CI_COMMIT_BEFORE_SHA`

   None set (for example the first push of a new branch, or a scheduled pipeline) is a configuration error. `ci` never falls back to `HEAD~1` or similar.
2. **History.** It fetches the base from `origin` (`--remote` to change, `--no-fetch` to use local history only). In a shallow checkout it deepens step by step, then unshallows. If there is still no merge-base, it exits 2 with the reason.
3. **Judgement.** run-checks and verify run against the same merge-base. Context staleness that already exists on the base counts as the target branch's maintenance, the same rule `deliver` applies; plain `verify` stays strict.
4. **No local state.** It neither reads nor writes delivery stamps, task records, or waivers. A waiver recorded by a local `run-checks` does not apply in CI: add the test, or change the module's policy in the manifest.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Passed: the selected checks and verify passed (or nothing changed against the merge-base). |
| 1 | The change failed: a check failed, a blocking gap remains, or verify failed. |
| 2 | Configuration / environment error; the change was not judged. No base, invalid base, base not found, shallow history that cannot be deepened, no common history, no manifest, or a malformed command line. |

## JSON (`--json`)

One `ai-harness/ci-report/v1` document:

- `status`: `passed` / `failed` / `error`. Also `ok`, `exitCode`, and `errorKind` (set on error: `no-base`, `invalid-base`, `unresolved-base`, `shallow-history`, `no-merge-base`, `not-adopted`, ...).
- `base`: `source` (for example `GITHUB_BASE_REF`), `value`, the locally resolved `ref` and `commit`, `mergeBase`, and `head`.
- `history`: `shallow`, `fetch` (`fetched` / `present` / `skipped` / `failed` / `unavailable`), `deepened`, `unshallowed`, every git `commands` run, and `warnings`.
- `changed`; `checks` (each selected check with `status`, `exitCode`, `durationMs`); `blockingGaps`.
- `runChecks` and `verify`: the full run-checks and verify reports. `verifyPassed` is a boolean.
- `errors`.

Files the job itself creates before `ci` runs (build output that is not ignored) become part of the judged change, so run `ci` on the fresh checkout or keep generated files in `.gitignore`.
