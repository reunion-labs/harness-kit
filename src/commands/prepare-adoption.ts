import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareAdoptionCandidate } from "../adoption";
import { readBaseline } from "../contracts";
import { loadManifest } from "../manifest";
import { inspectContextFreshness } from "../state";
import { info, ok, warn } from "../util";

const UNRESOLVED_SHOWN = 20;

export interface PrepareAdoptionCommandOpts {
  output: string;
  json?: boolean;
}

/**
 * Steps that write landing evidence. Done after the audit, they make the
 * receipt stale, so prepare names them while the candidate can still be redone.
 */
function landingPreconditions(repo: string): string[] {
  const notes: string[] = [];
  try {
    const manifest = loadManifest(repo);
    for (const contract of manifest.contracts ?? []) {
      if (contract.snapshot && readBaseline(repo, contract.id) === null)
        notes.push(
          `contract ${contract.id} has no accepted baseline; run accept-contract before preparing ` +
            `(.agents/contracts/${contract.id}.snapshot is landing evidence, so accepting it after the audit makes the receipt stale)`,
        );
    }
    for (const issue of inspectContextFreshness(repo, manifest)) {
      if (issue.severity === "blocking")
        notes.push(
          `${issue.key}: ${issue.reason}; record the review before preparing ` +
            "(.agents/.harness-state.json is landing evidence, so a later review makes the receipt stale)",
        );
    }
  } catch (error) {
    notes.push(`cannot check contract baselines and context reviews: ${(error as Error).message}`);
  }
  if (existsSync(join(repo, ".agents", "hooks")))
    notes.push("session hooks are already installed; onboarding installs them last, after the takeover and a green verify");
  return notes;
}

export function prepareAdoptionCmd(repo: string, opts: PrepareAdoptionCommandOpts): number {
  if (!opts.output?.trim()) throw new Error("candidate output directory is required");
  const output = resolve(opts.output);
  const candidate = prepareAdoptionCandidate(repo, output);
  const unresolved = candidate.unresolved ?? [];
  const preconditions = landingPreconditions(repo);
  const result = {
    ok: true,
    schema: candidate.schema,
    candidateHash: candidate.candidateHash,
    output,
    assurance: candidate.assurance,
    independence: candidate.independence,
    legacyEvidenceCount: candidate.legacy.length,
    landingEvidenceCount: candidate.landing.length,
    worktreeEvidenceCount: candidate.worktree.length,
    targetCount: candidate.targets.length,
    unresolvedReferenceCount: unresolved.length,
    unresolvedReferences: unresolved,
    preconditions,
  };
  if (opts.json) process.stdout.write(JSON.stringify(result) + "\n");
  else {
    ok(`prepared adoption candidate ${candidate.candidateHash} at ${output}`);
    ok(
      `bundle: ${candidate.legacy.length} legacy, ${candidate.guidance.length} guidance, ${candidate.landing.length} landing, ` +
        `${candidate.worktree.length} other worktree change(s), ${candidate.targets.length} generated, ${unresolved.length} unresolved mention(s)`,
    );
    info(`  ${candidate.index.artifact} maps every repository path to its artifact and lists what is absent by design`);
    if (unresolved.length) {
      warn(
        `${unresolved.length} bare path mention(s) name no in-repository file; they are bound in candidate.json "unresolved" ` +
          "and the blind auditor must confirm each one hides no guidance:",
      );
      for (const item of unresolved.slice(0, UNRESOLVED_SHOWN)) info(`  ${item.source}: ${item.reference} (${item.reason})`);
      if (unresolved.length > UNRESOLVED_SHOWN) info(`  ... ${unresolved.length - UNRESOLVED_SHOWN} more in candidate.json`);
    }
    for (const note of preconditions) warn(note);
  }
  return 0;
}
