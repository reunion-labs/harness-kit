# Thin-mode lifecycle proof, adoption landing evidence, per-glob doctor checks

Date: 2026-11-24

## Decisions

1. **The default thin Stop leaves lifecycle proof.**
   - Every Stop, thin or execute, records an observation on its SessionStart session: mode, allow/block, reason, and change fingerprint.
   - When a thin Stop allows because an accepted `deliver` stamp covers the change, it binds that stamp's evidence to the session (`source: "deliver-stamp"`). The `ACTIVE` hook state and `evidence.hookActive` therefore become reachable without execute mode. Their meaning is unchanged: valid gate evidence plus the hook configuration bound at SessionStart.
   - A blocked thin Stop clears the bound evidence and reports `DEGRADED`, the same as a failed execute run.
   - A Stop on a clean tree is recorded but is not gate proof.
   - Recording a Stop never moves the manual latest pointer, because deliver stamps are read from that pointer. A Stop that has no SessionStart session records nothing.
   - `evidence --json` adds a `lifecycle` object. By default, `hookActive` is computed from the latest lifecycle session, not from the latest pointer.
   - Stop mode stays a per-process environment choice (`HARNESS_KIT_STOP_MODE`). There is intentionally no project-level mode setting yet.
2. **Adoption candidates bind where migrated rules landed.**
   - `prepare-adoption` records landing evidence: every file under `.agents/`, plus every `root: repo` knowledge document.
   - Excluded are files the bundle already binds in another form (manifest, generated entries, legacy adoption evidence) and machine state (`hooks/`, `.harness-state.json`, `harness.lock.json`).
   - Landing evidence is part of the candidate hash and is re-verified byte for byte at apply time.
   - Regular files appear under `landing/<path>` so a blind auditor can check each legacy rule in place. Symlinks are recorded and never followed.
   - A candidate without `landing` must be prepared again.
3. **doctor checks impact globs one by one**, using the planner's picomatch semantics. A dead `owns` glob or a dead `tests` glob is reported even when the module has other matches.
4. **Onboarding pins one version.** `onboard` prints `npx -y @erzhe/harness-kit@<the printing version>`; `init` records it in the lock, and later commands follow the lock. The skill also defines how to handle legacy writing principles that conflict with machine-checked declarations: judge, record as rewritten with the anti-drift mechanism, and escalate.

## Why

Two onboarding pilots, run on 0.6.0, exposed these gaps:

- The onboarding skill demanded `hookActive: true`, which the default thin mode could never produce.
- Auditors could not see knowledge or checks files, so landing copies had to be passed outside the hash.
- doctor missed single dead globs.
- Blind audits failed 5 and 7 rounds over "no directory/interface lists" principles versus `owns` and contract snapshots.

## Boundaries

- Thin-mode proof depends on a change passing through the gate in that session. Hook execution on a clean tree is visible in `lifecycle.stop` but does not set `hookActive`.
- Landing discovery walks the filesystem like guidance discovery. Ignored files placed under `.agents/` are bound as well, so keep generated artifacts out of `.agents/`.
