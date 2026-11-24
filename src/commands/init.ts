import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureLegacyEntries } from "../adoption";
import { inspectManagedFiles, writeManagedFiles, type ManagedFileTarget } from "../managed-files";
import pkg from "../../package.json";
import { repoHarnessInvocation } from "../harness-cli";
import { err, info, ok } from "../util";
import { initialUpgradeState, UPGRADE_STATE_REL } from "../upgrade";

interface Starter {
  /** Shown in the template and the init output; the commands are only a starting point. */
  detected: string;
  capabilities: Array<[string, string]>;
  /** The console.log / secret examples only fit a JS/TS tree that really has src/. */
  jsSourceInvariants: boolean;
}

function readScripts(repo: string): Record<string, string> {
  try {
    const value = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts?: unknown };
    const scripts = value?.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
    return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function nodeStarter(repo: string): Starter {
  const pm = existsSync(join(repo, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(join(repo, "yarn.lock"))
      ? "yarn"
      : existsSync(join(repo, "bun.lock")) || existsSync(join(repo, "bun.lockb"))
        ? "bun"
        : "npm";
  const setup =
    pm === "npm" ? (existsSync(join(repo, "package-lock.json")) ? "npm ci" : "npm install") : `${pm} install`;
  const run = (script: string): string =>
    pm === "npm" ? (script === "test" ? "npm test" : `npm run ${script}`) : pm === "bun" ? `bun run ${script}` : `${pm} ${script}`;
  const scripts = readScripts(repo);
  const capabilities: Array<[string, string]> = [["setup", setup]];
  for (const script of ["build", "typecheck", "test", "lint"]) {
    const body = scripts[script];
    // npm init's placeholder test script always fails; it is not a real check.
    if (body && !/no test specified/.test(body)) capabilities.push([script, run(script)]);
  }
  return { detected: `${pm} (package.json)`, capabilities, jsSourceInvariants: existsSync(join(repo, "src")) };
}

/** Starting commands from the files the repository really has; never a fixed JS template. */
function detectStarter(repo: string): Starter {
  if (existsSync(join(repo, "go.mod")))
    return {
      detected: "Go (go.mod)",
      capabilities: [
        ["setup", "go mod download"],
        ["build", "go build ./..."],
        ["test", "go test ./..."],
        ["vet", "go vet ./..."],
      ],
      jsSourceInvariants: false,
    };
  if (existsSync(join(repo, "Cargo.toml")))
    return {
      detected: "Rust (Cargo.toml)",
      capabilities: [
        ["build", "cargo build"],
        ["test", "cargo test"],
      ],
      jsSourceInvariants: false,
    };
  if (existsSync(join(repo, "package.json"))) return nodeStarter(repo);
  return { detected: "no known build file", capabilities: [], jsSourceInvariants: false };
}

const JS_SOURCE_INVARIANTS = `invariants:
  - id: no-console-log
    rule: No stray console.log left in source
    enforcement:
      forbid_pattern: ["console\\\\.log\\\\("]
      path_glob: ["src/**"]
  - id: no-hardcoded-secret
    rule: Do not hardcode secrets / tokens in source
    enforcement:
      forbid_pattern: ["(password|secret|token)\\\\s*[:=]\\\\s*[\\"'][^\\"']+[\\"']"]
      path_glob: ["src/**"]
`;

const NO_INVARIANTS = `# Add only rules this repository really enforces, e.g.
#   - id: no-debug-print
#     rule: No debug prints in production code
#     enforcement: { forbid_pattern: ["fmt\\\\.Println\\\\("], path_glob: ["internal/**/*.go"] }
invariants: []
`;

function manifestTemplate(name: string, starter: Starter): string {
  const capabilities = [
    ...starter.capabilities,
    // Whitespace errors in the task diff; HARNESS_KIT_BASE is the task base when run-checks runs it.
    ["diff_check", "git diff --check ${HARNESS_KIT_BASE:-HEAD}"],
  ]
    .map(([verb, run]) => `  ${verb}: { run: ${JSON.stringify(run)} }`)
    .join("\n");
  return `spec: ai-harness/v0

identity:
  name: ${name}
  summary: TODO one-line description of what this repo is
  scope_in: []
  scope_out: []
  upstream: []
  downstream: []

# Starter commands detected from ${starter.detected}. Confirm each one really runs here.
capabilities:
${capabilities}

environment: []

contracts: []

${starter.jsSourceInvariants ? JS_SOURCE_INVARIANTS : NO_INVARIANTS}
knowledge:
  - path: knowledge/domain.md
    role: domain
  - path: knowledge/conventions.md
    role: conventions
  - path: knowledge/journal/
    role: journal

validation:
  defaults:
    # Changes that map to no module still get a check instead of no-checks-selected.
    no_match: [diff_check]

playbooks:
  dir: playbooks/
`;
}

export function initCmd(repo: string, name: string, force: boolean): number {
  const starter = detectStarter(repo);
  const targets: ManagedFileTarget[] = [
    [".agents/manifest.yaml", manifestTemplate(name, starter)],
    [UPGRADE_STATE_REL, initialUpgradeState(pkg.name, pkg.version, "ai-harness/v0")],
    [
      ".agents/knowledge/domain.md",
      `# ${name} — domain\n\nWhat this project does and its key concepts.\nWrite only what an agent cannot infer from the code.\n`,
    ],
    [
      ".agents/knowledge/conventions.md",
      "# Conventions\n\nNaming, patterns, and style preferences that are not obvious from the code.\n",
    ],
    [".agents/knowledge/journal/.gitkeep", ""],
    [".agents/playbooks/.gitkeep", ""],
    [".agents/adoption.md", adoptionTemplate()],
  ];

  // This check deliberately happens before legacy capture: a normal init that
  // finds any scaffold target must be a true zero-write refusal, including no
  // adoption index or snapshots. writeManagedFiles repeats the same policy on
  // its own preflight so a target racing into existence is never overwritten.
  const collisions = inspectManagedFiles(repo, targets).filter((target) => target.kind !== "missing");
  if (collisions.length && !force) {
    err(`init scaffold 已存在（用 --force 覆盖）: ${collisions.map((item) => item.relativePath).join(", ")}`);
    return 1;
  }

  const adoption = captureLegacyEntries(repo);
  if (adoption.entries.length)
    ok(`captured ${adoption.entries.length} legacy agent entry/entries under .agents/adoption/ (no root file overwritten)`);
  const result = writeManagedFiles(repo, targets, {
    authorize: (inspections) => {
      if (force) return;
      const appeared = inspections.filter((target) => target.kind !== "missing");
      if (appeared.length)
        throw new Error(`init scaffold changed after preflight: ${appeared.map((item) => item.relativePath).join(", ")}`);
    },
  });
  for (const path of result.written) ok(`wrote ${path}`);

  info(`\nStarter capabilities come from ${starter.detected}; confirm each command before relying on it.`);
  info(`Next: edit .agents/manifest.yaml, then run \`${repoHarnessInvocation(repo)} sync\`.`);
  return 0;
}

function adoptionTemplate(): string {
  return `# Tooling adoption log

Earn heavier tooling with evidence. Default posture: prefer the lightest thing that works,
and only promote a convention to a machine check (\`harness-kit verify\`) after it actually bites.

## When to promote a soft convention to an enforced invariant
- The same mistake slipped through 3+ times, OR
- A manual convention held for 1+ week and is clearly worth locking in.

## Log
- (date) observation / friction / decision
`;
}
