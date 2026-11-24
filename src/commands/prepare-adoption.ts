import { resolve } from "node:path";
import { prepareAdoptionCandidate } from "../adoption";
import { info, ok, warn } from "../util";

const UNRESOLVED_SHOWN = 20;

export interface PrepareAdoptionCommandOpts {
  output: string;
  json?: boolean;
}

export function prepareAdoptionCmd(repo: string, opts: PrepareAdoptionCommandOpts): number {
  if (!opts.output?.trim()) throw new Error("candidate output directory is required");
  const output = resolve(opts.output);
  const candidate = prepareAdoptionCandidate(repo, output);
  const unresolved = candidate.unresolved ?? [];
  const result = {
    ok: true,
    schema: candidate.schema,
    candidateHash: candidate.candidateHash,
    output,
    assurance: candidate.assurance,
    independence: candidate.independence,
    legacyEvidenceCount: candidate.legacy.length,
    landingEvidenceCount: candidate.landing.length,
    targetCount: candidate.targets.length,
    unresolvedReferenceCount: unresolved.length,
    unresolvedReferences: unresolved,
  };
  if (opts.json) process.stdout.write(JSON.stringify(result) + "\n");
  else {
    ok(`prepared adoption candidate ${candidate.candidateHash} at ${output}`);
    ok(
      `bundle: ${candidate.legacy.length} legacy, ${candidate.guidance.length} guidance, ${candidate.landing.length} landing, ` +
        `${candidate.targets.length} generated, ${unresolved.length} unresolved mention(s)`,
    );
    if (unresolved.length) {
      warn(
        `${unresolved.length} bare path mention(s) name no in-repository file; they are bound in candidate.json "unresolved" ` +
          "and the blind auditor must confirm each one hides no guidance:",
      );
      for (const item of unresolved.slice(0, UNRESOLVED_SHOWN)) info(`  ${item.source}: ${item.reference} (${item.reason})`);
      if (unresolved.length > UNRESOLVED_SHOWN) info(`  ... ${unresolved.length - UNRESOLVED_SHOWN} more in candidate.json`);
    }
  }
  return 0;
}
