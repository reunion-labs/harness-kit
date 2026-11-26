import pkg from "../../package.json";
import { assertFirstEntryAuthorized, assertManagedFileAdoption, assertManagedFileAdoptionReceipt } from "../adoption";
import { HARNESS_LOCK_REL, lockedHarnessVersion } from "../harness-cli";
import { loadManifest, validateManifest } from "../manifest";
import { writeManagedFiles } from "../managed-files";
import { renderTargets } from "../render";
import { info, ok, warn } from "../util";

export interface SyncOpts {
  adoptExisting?: boolean;
  adoptionCandidate?: string;
  adoptionAudit?: string;
  /** Explicitly create the first AGENTS.md without an adoption audit (repository with no agent guidance). */
  createEntry?: boolean;
}

export function syncCmd(repo: string, opts: SyncOpts = {}): void {
  const m = loadManifest(repo);
  const errors = validateManifest(m).filter((issue) => issue.level === "error");
  if (errors.length) throw new Error(`manifest invalid: ${errors.map((issue) => issue.msg).join("; ")}`);
  info("Syncing generated files from .agents/manifest.yaml ...");
  const harnessVersion = lockedHarnessVersion(repo);
  if (harnessVersion && harnessVersion !== pkg.version)
    warn(
      `running harness-kit ${pkg.version} but ${HARNESS_LOCK_REL} pins ${harnessVersion}; generated entries keep pinning ${harnessVersion}. ` +
        "Use `upgrade` to move the repository to this version.",
    );
  const targets = renderTargets(m, { harnessVersion });
  if (opts.adoptExisting && opts.createEntry)
    throw new Error("--create-entry skips the adoption audit; it cannot be combined with --adopt-existing");
  if (!!opts.adoptionCandidate !== !!opts.adoptionAudit)
    throw new Error("adoption requires both --candidate <bundle> and --audit <receipt>");
  if ((opts.adoptionCandidate || opts.adoptionAudit) && !opts.adoptExisting)
    throw new Error("--candidate/--audit are only valid with --adopt-existing");
  if (opts.adoptExisting && !opts.adoptionCandidate)
    throw new Error("--adopt-existing requires --candidate <bundle> and --audit <receipt>; legacy snapshot + --adopt-existing alone is not authorization");
  const result = writeManagedFiles(repo, targets, {
    authorize: (inspections) => {
      if (opts.adoptExisting && opts.adoptionCandidate && opts.adoptionAudit) {
        // An explicit takeover proves the receipt before any write, even when
        // there is no legacy entry to adopt; only a pure no-op skips it.
        if (inspections.every((inspection) => inspection.satisfiesDesired)) return;
        assertManagedFileAdoptionReceipt(repo, inspections, opts.adoptionCandidate, opts.adoptionAudit);
        return;
      }
      // This also permits compatibility no-ops when every target is already
      // managed/current, but an actual first takeover cannot pass without the
      // content-bound candidate + audit receipt pair above.
      assertManagedFileAdoption(repo, inspections, false);
      assertFirstEntryAuthorized(repo, inspections, !!opts.createEntry);
    },
  });
  const preservedAliases = new Set(result.preservedAliases);
  const written = new Set(result.written);
  for (const [rel] of targets) {
    if (preservedAliases.has(rel)) ok(`preserved ${rel} -> AGENTS.md`);
    else if (written.has(rel)) ok(`wrote ${rel}`);
    else ok(`${rel} already current`);
  }
  info("Context review evidence was not changed; use `record-context-review` only after an Agent reviews the context.");
}
