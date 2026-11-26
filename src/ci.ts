import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gitRoot } from "./git";

/**
 * Where the CI gate's base came from. Explicit settings win over what a CI
 * platform exposes; there is no fallback such as HEAD~1.
 */
export type CiBaseSource =
  | "option"
  | "HARNESS_KIT_BASE"
  | "CI_MERGE_REQUEST_DIFF_BASE_SHA"
  | "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
  | "GITHUB_BASE_REF"
  | "GITHUB_EVENT_PATH:before"
  | "GITHUB_EVENT_PATH:merge_group.base_sha"
  | "CI_COMMIT_BEFORE_SHA";

export interface CiBaseRequest {
  source: CiBaseSource;
  value: string;
}

export type CiErrorKind =
  | "no-base"
  | "invalid-base"
  | "unresolved-base"
  | "shallow-history"
  | "no-merge-base"
  | "not-a-repo"
  | "no-head";

/** A configuration or environment problem: the change was never judged. */
export class CiConfigError extends Error {
  constructor(
    public readonly kind: CiErrorKind,
    message: string,
    public readonly history: CiHistory | null = null,
    /** What was already resolved before the failure (base ref / commit, HEAD). */
    public readonly resolved: Partial<Pick<CiBase, "ref" | "commit" | "head">> = {},
  ) {
    super(message);
    this.name = "CiConfigError";
  }
}

export interface CiHistory {
  remote: string;
  /** The checkout was shallow before ci touched it. */
  shallow: boolean;
  /** fetched: base fetched from the remote; present: base commit already local; skipped: --no-fetch; failed / unavailable: could not fetch. */
  fetch: "fetched" | "present" | "skipped" | "failed" | "unavailable";
  /** Commits requested with --deepen in total. */
  deepened: number;
  unshallowed: boolean;
  /** Every git fetch ci ran, in order, for the job log. */
  commands: string[];
  warnings: string[];
}

export interface CiBase {
  source: CiBaseSource;
  value: string;
  /** What `value` resolved to locally, e.g. refs/remotes/origin/main. */
  ref: string;
  commit: string;
  mergeBase: string;
  head: string;
}

const ZERO_SHA = /^0+$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const HEX = /^[0-9a-f]{7,64}$/i;
// A ref name, a remote-tracking name, or a revision: never an option, a range, or a refspec.
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9._/@{}~^+-]*$/;
const DEEPEN_STEPS = [50, 200, 1000];
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;

function env(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function realCommit(value: string | undefined): string | null {
  const sha = env(value);
  return sha && !ZERO_SHA.test(sha) ? sha : null;
}

function githubEvent(environment: NodeJS.ProcessEnv): Record<string, unknown> | null {
  const path = env(environment.GITHUB_EVENT_PATH);
  if (!path) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The base this CI run judges against, in priority order:
 * 1. `--base`, 2. HARNESS_KIT_BASE, 3. GitLab merge request pipelines
 * (diff base SHA, or the target branch for merged-result / merge-train
 * pipelines, whose HEAD is a merge commit on top of the target),
 * 4. GitHub pull requests (GITHUB_BASE_REF), 5. the pushed range of a GitHub
 * push / merge_group event or a GitLab push pipeline. null when none applies.
 */
export function detectCiBase(option: string | undefined, environment: NodeJS.ProcessEnv): CiBaseRequest | null {
  const explicit = env(option);
  if (explicit) return { source: "option", value: explicit };
  const generic = env(environment.HARNESS_KIT_BASE);
  if (generic) return { source: "HARNESS_KIT_BASE", value: generic };

  const target = env(environment.CI_MERGE_REQUEST_TARGET_BRANCH_NAME);
  const diffBase = realCommit(environment.CI_MERGE_REQUEST_DIFF_BASE_SHA);
  const mergedResult = ["merged_result", "merge_train"].includes(env(environment.CI_MERGE_REQUEST_EVENT_TYPE) ?? "");
  if (target && (mergedResult || !diffBase)) return { source: "CI_MERGE_REQUEST_TARGET_BRANCH_NAME", value: target };
  if (diffBase) return { source: "CI_MERGE_REQUEST_DIFF_BASE_SHA", value: diffBase };

  const pullBase = env(environment.GITHUB_BASE_REF);
  if (pullBase) return { source: "GITHUB_BASE_REF", value: pullBase };
  const event = env(environment.GITHUB_EVENT_NAME);
  if (event === "push" || event === "merge_group") {
    const payload = githubEvent(environment);
    if (event === "push") {
      const before = realCommit(typeof payload?.before === "string" ? payload.before : undefined);
      if (before) return { source: "GITHUB_EVENT_PATH:before", value: before };
    } else {
      const group = payload?.merge_group as { base_sha?: unknown } | undefined;
      const sha = realCommit(typeof group?.base_sha === "string" ? group.base_sha : undefined);
      if (sha) return { source: "GITHUB_EVENT_PATH:merge_group.base_sha", value: sha };
    }
  }
  const before = realCommit(environment.CI_COMMIT_BEFORE_SHA);
  if (before && env(environment.GITLAB_CI)) return { source: "CI_COMMIT_BEFORE_SHA", value: before };
  return null;
}

export const NO_BASE_MESSAGE =
  "no base to judge this change against: pass --base <ref> or set HARNESS_KIT_BASE. " +
  "Detected automatically: GitLab merge request pipelines (CI_MERGE_REQUEST_DIFF_BASE_SHA / CI_MERGE_REQUEST_TARGET_BRANCH_NAME), " +
  "GitHub pull_request (GITHUB_BASE_REF), and the pushed range of a GitHub push / merge_group event or a GitLab push pipeline " +
  "(none exists for a newly created branch). ci never guesses a base such as HEAD~1.";

function errorText(error: unknown): string {
  const e = error as { stderr?: Buffer | string; message?: string };
  const stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : e.stderr;
  return String(stderr || e.message || error).trim().split("\n").slice(-3).join(" ");
}

function git(root: string, args: string[], timeout?: number): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    // A CI job must fail, not wait for a password prompt.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function tryGit(root: string, args: string[]): string | null {
  try {
    return git(root, args).trim();
  } catch {
    return null;
  }
}

function commitOf(root: string, ref: string): string | null {
  return tryGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
}

function isShallow(root: string): boolean {
  return tryGit(root, ["rev-parse", "--is-shallow-repository"]) === "true";
}

function mergeBase(root: string, commit: string, head: string): string | null {
  return tryGit(root, ["merge-base", "--end-of-options", commit, head]);
}

interface BaseTarget {
  /** What to resolve locally after fetching, most specific first. */
  candidates: string[];
  /** What to ask the remote for (refspec or commit); null when it cannot be fetched. */
  want: string | null;
  commit: boolean;
}

function baseTarget(value: string, remote: string): BaseTarget {
  if (FULL_SHA.test(value)) return { candidates: [value], want: value, commit: true };
  if (HEX.test(value)) return { candidates: [value], want: null, commit: true };
  let branch: string | null = value;
  if (value.startsWith("refs/heads/")) branch = value.slice("refs/heads/".length);
  else if (value.startsWith(`refs/remotes/${remote}/`)) branch = value.slice(`refs/remotes/${remote}/`.length);
  else if (value.startsWith(`${remote}/`)) branch = value.slice(remote.length + 1);
  else if (value.startsWith("refs/")) branch = null;
  if (branch === null) return { candidates: [value], want: `+${value}:${value}`, commit: false };
  const tracking = `refs/remotes/${remote}/${branch}`;
  return { candidates: [tracking, value], want: `+refs/heads/${branch}:${tracking}`, commit: false };
}

/**
 * Make the base and HEAD share history locally, then resolve their merge-base.
 * Fetches the base (a branch always, a commit only when missing), deepens a
 * shallow checkout step by step and finally unshallows it. Never passes
 * silently: without a merge-base this throws CiConfigError.
 */
export function prepareCiBase(
  repo: string,
  request: CiBaseRequest,
  opts: { fetch: boolean; remote: string },
): { base: CiBase; history: CiHistory } {
  let root: string;
  try {
    root = gitRoot(repo);
  } catch (error) {
    throw new CiConfigError("not-a-repo", (error as Error).message);
  }
  const { value } = request;
  if (!SAFE_REF.test(value) || value.includes("..") || value.includes("@{-"))
    throw new CiConfigError("invalid-base", `invalid base from ${request.source}: ${JSON.stringify(value)} (expected a branch, ref, or commit)`);
  if (!SAFE_REF.test(opts.remote)) throw new CiConfigError("invalid-base", `invalid --remote: ${JSON.stringify(opts.remote)}`);

  const head = commitOf(root, "HEAD");
  if (!head) throw new CiConfigError("no-head", "HEAD has no commit; check out the change before running ci");
  const shallow = isShallow(root);
  const history: CiHistory = {
    remote: opts.remote,
    shallow,
    fetch: opts.fetch ? "unavailable" : "skipped",
    deepened: 0,
    unshallowed: false,
    commands: [],
    warnings: [],
  };
  const target = baseTarget(value, opts.remote);
  const remoteExists = opts.fetch && tryGit(root, ["remote", "get-url", "--", opts.remote]) !== null;
  let lastFetchError = "";
  const fetch = (flags: string[], wants: string[]): boolean => {
    const args = ["fetch", "--no-tags", "--quiet", ...flags, "--end-of-options", opts.remote, ...wants];
    history.commands.push(`git ${args.join(" ")}`);
    try {
      git(root, args, FETCH_TIMEOUT_MS);
      return true;
    } catch (error) {
      lastFetchError = errorText(error);
      return false;
    }
  };

  if (opts.fetch && !remoteExists) history.warnings.push(`remote ${opts.remote} is not configured; using local history only`);
  if (remoteExists) {
    if (target.commit && commitOf(root, value)) history.fetch = "present";
    else if (target.want) {
      const depth = shallow ? [`--depth=${DEEPEN_STEPS[0]}`] : [];
      history.fetch = fetch(depth, [target.want]) ? "fetched" : "failed";
      if (history.fetch === "failed") history.warnings.push(`could not fetch ${value} from ${opts.remote}: ${lastFetchError}`);
    }
  }

  let resolvedRef = "";
  let commit: string | null = null;
  for (const candidate of target.candidates) {
    commit = commitOf(root, candidate);
    if (commit) {
      resolvedRef = candidate;
      break;
    }
  }
  if (!commit) {
    const why = !opts.fetch
      ? "fetching is off (--no-fetch)"
      : !remoteExists
        ? `remote ${opts.remote} is not configured`
        : history.fetch === "failed"
          ? `fetch failed: ${lastFetchError}`
          : "it is not in the local history";
    throw new CiConfigError("unresolved-base", `cannot resolve base ${value} (from ${request.source}): ${why}`, history, { head });
  }
  if (!target.commit && history.fetch !== "fetched" && resolvedRef === value)
    history.warnings.push(`judging against the local ${value}, which may be behind ${opts.remote}`);

  let found = mergeBase(root, commit, head);
  // Deepen both sides: a shallow HEAD has no parents, even when the base is present.
  const wants = [...(target.want ? [target.want] : []), head];
  if (!found && remoteExists) {
    for (const step of DEEPEN_STEPS) {
      if (!isShallow(root)) break;
      const deepened = fetch([`--deepen=${step}`], wants) || fetch([`--deepen=${step}`], []);
      if (!deepened) break;
      history.deepened += step;
      found = mergeBase(root, commit, head);
      if (found) break;
    }
    if (!found && isShallow(root) && (fetch(["--unshallow"], wants) || fetch(["--unshallow"], []))) {
      history.unshallowed = true;
      found = mergeBase(root, commit, head);
    }
  }
  if (!found) {
    if (isShallow(root)) {
      const how = !opts.fetch
        ? "fetching is off (--no-fetch)"
        : !remoteExists
          ? `remote ${opts.remote} is not configured`
          : `deepening from ${opts.remote} failed: ${lastFetchError || "history still incomplete"}`;
      throw new CiConfigError(
        "shallow-history",
        `shallow checkout: no merge-base between ${value} and HEAD in the local history, and ${how}. ` +
          "Check out the full history (GitHub actions/checkout fetch-depth: 0, GitLab GIT_DEPTH: 0) or let ci fetch.",
        history,
        { ref: resolvedRef, commit, head },
      );
    }
    throw new CiConfigError("no-merge-base", `${value} (${commit}) and HEAD (${head}) share no history`, history, { ref: resolvedRef, commit, head });
  }
  return {
    base: { source: request.source, value, ref: resolvedRef, commit, mergeBase: found, head },
    history,
  };
}
