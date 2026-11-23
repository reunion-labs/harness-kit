import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

export const HARNESS_LOCK_REL = ".agents/harness.lock.json";
export const HARNESS_PACKAGE = pkg.name;

// Rendered into AGENTS.md and printed as runnable NEXT commands, so only plain
// semver characters may ever reach that text.
const SAFE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Version pinned by the repository's `.agents/harness.lock.json`, or null when
 * the lock is absent, not a regular file, malformed, or belongs to another package.
 */
export function lockedHarnessVersion(repo: string): string | null {
  const path = join(repo, HARNESS_LOCK_REL);
  try {
    if (!lstatSync(path).isFile()) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as { package?: unknown; version?: unknown };
    if (value?.package !== HARNESS_PACKAGE || typeof value.version !== "string") return null;
    return SAFE_VERSION.test(value.version) ? value.version : null;
  } catch {
    return null;
  }
}

/**
 * The exact command an Agent can run without a global install. Same npx form as
 * the lifecycle Hook runner; without a pinned version it falls back to @latest.
 */
export function harnessInvocation(version?: string | null): string {
  const pinned = version && SAFE_VERSION.test(version) ? version : "latest";
  return `npx -y ${HARNESS_PACKAGE}@${pinned}`;
}

/** harnessInvocation() pinned by this repository's lock. */
export function repoHarnessInvocation(repo: string): string {
  return harnessInvocation(lockedHarnessVersion(repo));
}
