import { loadManifest, validateManifest } from "../manifest";
import { recordContextReviews } from "../state";
import { ok } from "../util";

export interface RecordContextReviewCommandOpts {
  /** Repeatable; one Agent review may cover several contexts. */
  path?: string | string[];
  module?: string | string[];
  reason: string;
  session?: string;
  json?: boolean;
}

const list = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

export function recordContextReviewCmd(repo: string, opts: RecordContextReviewCommandOpts): number {
  const manifest = loadManifest(repo);
  const errors = validateManifest(manifest).filter((issue) => issue.level === "error");
  if (errors.length) throw new Error(`manifest invalid: ${errors.map((issue) => issue.msg).join("; ")}`);
  const records = recordContextReviews(repo, manifest, {
    paths: list(opts.path),
    modules: list(opts.module),
    reason: opts.reason,
    session: opts.session,
  });
  if (opts.json) process.stdout.write(JSON.stringify({ ok: true, review: records[0], reviews: records }) + "\n");
  else for (const record of records) ok(`recorded context review: ${record.key} — ${record.reason}`);
  return 0;
}
