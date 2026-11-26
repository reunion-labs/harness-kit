import fg from "fast-glob";
import picomatch from "picomatch";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildHarnessGuidance, contextFreshnessActions } from "../guidance";
import { lockedHarnessVersion, repoHarnessInvocation } from "../harness-cli";
import { inspectAgentHookStatus } from "../hook-status";
import { loadManifest, validateManifest, type Manifest } from "../manifest";
import { inspectManagedFiles } from "../managed-files";
import { agentsMdSize, renderTargets } from "../render";
import { inspectContextFreshness, readState, resolveKnowledgePath, type ContextFreshnessIssue } from "../state";
import { isHarnessGenerated } from "../adoption";
import { err, info, ok, readText, warn } from "../util";
import { inspectValidationGateHealth } from "../validation-gates";

// AGENTS.md must stay short (progressive disclosure): it is an index, not a dump.
// The word budget counts what the repository controls; the fixed Harness
// working agreement, header, and map (about 300 words) are the same everywhere.
// countWords makes the budget language-neutral (Han / Kana count half a word).
const AGENTS_MAX_LINES = 150;
const AGENTS_MAX_CONTENT_WORDS = 500;

const PINNED_INVOCATION = /@erzhe\/harness-kit@(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/g;
// The 0.7.x init scaffold of .agents/adoption.md named a bare command.
const LEGACY_ADOPTION_LINE = "(`harness-kit verify`)";
// From its `## Log` heading on, the adoption log records what happened (with
// the versions of the day); only the preamble above it is guidance.
const ADOPTION_REL = ".agents/adoption.md";
const ADOPTION_LOG_HEADING = /^##\s+Log\s*$/;

/**
 * Hand-written Harness commands that upgrade cannot rewrite: a pin to another
 * version than the lock, or the bare command of the 0.7.x adoption template.
 * Scans the manifest, hand-written .agents documents, and root=repo knowledge
 * documents; history is skipped: journal ADRs and the adoption Log onwards.
 */
function staleHandWrittenInvocations(repo: string, m: Manifest, locked: string | null): string[] {
  const files = new Set<string>([".agents/manifest.yaml"]);
  // Journal ADRs are history and may name the versions they were written for.
  for (const path of fg.sync([".agents/**/*.md"], { cwd: repo, dot: true, onlyFiles: true, ignore: [".agents/adoption/**", "**/journal/**"] }))
    files.add(path);
  for (const knowledge of m.knowledge ?? [])
    if (knowledge.root === "repo" && knowledge.role !== "journal" && /\.(md|mdx|markdown|txt)$/i.test(knowledge.path)) files.add(knowledge.path);
  const findings: string[] = [];
  for (const rel of [...files].sort()) {
    const text = readText(join(repo, rel));
    if (text === null || isHarnessGenerated(text)) continue;
    const lines = text.split("\n");
    const log = rel === ADOPTION_REL ? lines.findIndex((line) => ADOPTION_LOG_HEADING.test(line)) : -1;
    (log >= 0 ? lines.slice(0, log) : lines).forEach((line, index) => {
      for (const match of line.matchAll(PINNED_INVOCATION))
        if (locked && match[1] !== locked) findings.push(`${rel}:${index + 1} pins @erzhe/harness-kit@${match[1]}; the lock pins ${locked}`);
      if (line.includes(LEGACY_ADOPTION_LINE)) findings.push(`${rel}:${index + 1} names a bare \`harness-kit verify\`; say "the pinned \`verify\` command in AGENTS.md"`);
    });
  }
  return findings;
}

export interface DoctorOpts {
  details?: boolean;
}

export function doctorCmd(repo: string, opts: DoctorOpts = {}): number {
  const cli = repoHarnessInvocation(repo);
  let problems = 0;
  const m = loadManifest(repo);
  const render = { harnessVersion: lockedHarnessVersion(repo) };

  info("1) Manifest validation");
  const issues = validateManifest(m);
  if (!issues.length) ok("schema looks good");
  for (const i of issues) {
    if (i.level === "error") {
      err(i.msg);
      problems++;
    } else {
      warn(i.msg);
    }
  }
  if (issues.some((issue) => issue.level === "error")) {
    info("\ndoctor: manifest is invalid; fix schema errors before deeper checks");
    return 1;
  }
  // Guard against a "vacuous pass": an enforcement whose path_glob matches no
  // files silently passes `verify` while checking nothing — worse than no gate.
  for (const inv of m.invariants ?? []) {
    if (!inv.enforcement) continue;
    const globs = inv.enforcement.path_glob?.length ? inv.enforcement.path_glob : ["**/*"];
    const n = fg.sync(globs, {
      cwd: repo,
      onlyFiles: true,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    }).length;
    if (n === 0 && !inv.enforcement.allow_empty)
      warn(`invariant ${inv.id}: enforcement path_glob matches 0 files — passes without checking anything (wrong path_glob for this repo layout?)`);
  }
  // Map rot, per glob: one dead owns glob is a path whose changes can never
  // select its module; a dead tests glob can never satisfy test_touch. Matching
  // uses the planner's own picomatch semantics over one repository listing.
  const repoFiles = (m.modules ?? []).some((mod) => mod.owns?.length || mod.tests?.length)
    ? fg.sync("**/*", { cwd: repo, onlyFiles: true, dot: true, ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"] })
    : [];
  const matchesNothing = (glob: string): boolean => {
    const matcher = picomatch(glob, { dot: true });
    return !repoFiles.some((file) => matcher(file));
  };
  for (const mod of m.modules ?? []) {
    const deadOwns = (mod.owns ?? []).filter(matchesNothing);
    if (deadOwns.length && deadOwns.length === mod.owns!.length)
      warn(`module ${mod.name}: owns glob matches 0 files — impact planner can never select it (stale owns for this layout?)`);
    else
      for (const glob of deadOwns)
        warn(`module ${mod.name}: owns glob "${glob}" matches 0 files — changes under it can never select this module (stale path?)`);
    for (const glob of (mod.tests ?? []).filter(matchesNothing))
      warn(`module ${mod.name}: tests glob "${glob}" matches 0 files — it can never map a test change or satisfy test_touch (stale path?)`);
  }
  for (const glob of m.validation?.required_coverage ?? []) {
    const n = fg.sync(glob, {
      cwd: repo,
      onlyFiles: true,
      dot: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    }).length;
    if (n === 0)
      warn(`validation.required_coverage glob matches 0 files: ${glob} — a typo here silently weakens unmapped-file protection`);
  }
  for (const issue of inspectValidationGateHealth(repo, m)) {
    const message = `validation gate ${issue.gate}: ${issue.message}`;
    if (issue.level === "error") {
      err(message);
      problems++;
    } else {
      warn(message);
    }
  }

  info("\n2) Referenced paths");
  const checkPath = (rel: string, label: string) => {
    if (existsSync(join(repo, ".agents", rel))) ok(`${label}: ${rel}`);
    else {
      err(`${label} missing: .agents/${rel}`);
      problems++;
    }
  };
  // repo-relative path referenced by routing/modules (e.g. src/server.ts).
  // wantFile=true for entry/binds: they hash a file for freshness, so pointing
  // at a directory is a config mistake — warn instead of silently OK-ing it.
  const checkRepoPath = (rel: string, label: string, wantFile = false) => {
    const abs = join(repo, rel);
    if (!existsSync(abs)) {
      err(`${label} points at a missing path: ${rel}`);
      problems++;
    } else if (wantFile && statSync(abs).isDirectory()) {
      warn(`${label}: ${rel} is a directory — entry/binds should be a file (freshness hashes file content)`);
    } else ok(`${label}: ${rel}`);
  };
  const checkRepoPointer = (pointer: string, label: string) => {
    if (!fg.isDynamicPattern(pointer)) return checkRepoPath(pointer, label);
    const matches = fg.sync(pointer, {
      cwd: repo,
      onlyFiles: false,
      dot: true,
      followSymbolicLinks: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    });
    if (!matches.length) {
      err(`${label} glob matches 0 paths: ${pointer}`);
      problems++;
    } else ok(`${label} glob: ${pointer} (${matches.length} match(es))`);
  };
  for (const k of m.knowledge ?? []) {
    let knowledgePath: string;
    try {
      knowledgePath = resolveKnowledgePath(repo, k);
    } catch (error) {
      err((error as Error).message);
      problems++;
      continue;
    }
    if (existsSync(knowledgePath)) ok(`knowledge: ${k.path}`);
    else {
      err(`knowledge missing: ${k.root === "repo" ? "" : ".agents/"}${k.path}`);
      problems++;
    }
    for (const b of new Set(k.binds ?? [])) checkRepoPath(b, `knowledge "${k.path}" binds`, true);
  }
  if (m.playbooks?.dir) checkPath(m.playbooks.dir, "playbooks");
  // routing read/entry are navigation pointers (NOT freshness-bound) — dirs OK.
  for (const r of m.routing ?? [])
    for (const p of new Set([...(r.read ?? []), ...(r.entry ?? [])])) checkRepoPointer(p, `routing "${r.when}"`);
  for (const mod of m.modules ?? [])
    for (const p of new Set(mod.entry ?? [])) checkRepoPath(p, `module ${mod.name}`, true);
  // module.playbook must resolve to a real file (tries <playbooks.dir>, .agents/, repo-relative).
  for (const mod of m.modules ?? []) {
    if (!mod.playbook) continue;
    const candidates = [
      m.playbooks?.dir ? join(repo, ".agents", m.playbooks.dir, mod.playbook) : "",
      join(repo, ".agents", mod.playbook),
      join(repo, mod.playbook),
    ].filter(Boolean);
    if (candidates.some((c) => existsSync(c))) ok(`module ${mod.name} playbook: ${mod.playbook}`);
    else {
      err(`module ${mod.name} playbook missing: ${mod.playbook} (looked in ${m.playbooks?.dir ? `.agents/${m.playbooks.dir}/, ` : ""}.agents/, repo root)`);
      problems++;
    }
  }

  info("\n3) Generated files drift");
  try {
    for (const inspection of inspectManagedFiles(repo, renderTargets(m, render))) {
      if (inspection.kind === "missing") warn(`${inspection.relativePath} not generated yet (run \`${cli} sync\`)`);
      else if (!inspection.satisfiesDesired) {
        err(`${inspection.relativePath} drifted from manifest (run \`${cli} sync\`)`);
        problems++;
      } else if (inspection.kind === "allowed-alias") ok(`${inspection.relativePath} semantic alias -> AGENTS.md`);
      else ok(`${inspection.relativePath} in sync`);
    }
  } catch (error) {
    err(`generated-file safety check failed: ${(error as Error).message}`);
    problems++;
  }

  info("\n4) Knowledge freshness");
  let freshnessIssues: ContextFreshnessIssue[] = [];
  const prev = readState(repo);
  const boundCount = (m.knowledge ?? []).filter((item) => item.binds?.length || item.authority).length +
    (m.modules ?? []).filter((item) => item.entry?.length).length;
  if (boundCount === 0) {
    ok("no knowledge bound to source files (nothing to drift)");
  } else {
    const freshness = inspectContextFreshness(repo, m);
    freshnessIssues = freshness;
    if (!prev && !(m.knowledge ?? []).some((item) => item.authority))
      warn("no legacy freshness baseline yet; use `record-context-review` for durable Agent-reviewed context");
    for (const issue of freshness) {
      const changed = issue.changedSources.length ? ` -> ${issue.changedSources.join(", ")}` : "";
      const message = `${issue.key}: ${issue.reason}${changed}`;
      if (issue.severity === "blocking") {
        err(message);
        problems++;
      } else warn(message);
    }
    if (!freshness.length) ok("no knowledge drift");
  }

  const declaredGuidance = buildHarnessGuidance({ manifest: m });
  info("\n5) Declared verification boundaries");
  if (!declaredGuidance.gapSummary.total) ok("no declared verification boundaries");
  else {
    info(
      `${declaredGuidance.gapSummary.total} declared: ${declaredGuidance.gapSummary.recommended} automation improvement(s), ` +
        `${declaredGuidance.gapSummary.informational} check(s) only when relevant; these are not health failures`,
    );
    if (opts.details) {
      for (const gap of declaredGuidance.gapDetails) {
        const text = `[${gap.classification.toUpperCase()}] ${gap.title} — ${gap.when} ${gap.reason}`;
        if (gap.classification === "recommended") warn(text);
        else info(text);
      }
    } else info(`       details: \`${cli} doctor --details\``);
  }

  const stalePins = staleHandWrittenInvocations(repo, m, render.harnessVersion);
  if (stalePins.length) {
    info("\n5b) Hand-written Harness commands (upgrade never edits these files)");
    for (const finding of stalePins) warn(finding);
  }

  info("\n6) AGENTS.md size budget (must stay short — agents read it every session)");
  const size = agentsMdSize(m, render);
  const sizeText =
    `AGENTS.md ${size.lines} lines / ${size.words} words; repository content ${size.contentWords} words ` +
    `(budget ${AGENTS_MAX_LINES} lines / ${AGENTS_MAX_CONTENT_WORDS} content words; fixed Harness text not counted; ` +
    "a Han / Kana character is half a word)";
  if (size.lines > AGENTS_MAX_LINES || size.contentWords > AGENTS_MAX_CONTENT_WORDS) {
    warn(`${sizeText}. Move detail into .agents/knowledge/ and keep AGENTS.md as an index.`);
    const largest = size.sections.slice(0, 3).map((section) => `${section.heading} ${section.words}`).join(", ");
    info(
      `       largest sections (words): ${largest}. Keep each rule to the sentence an agent must obey and move its ` +
        "rationale and scope into knowledge; this is advisory maintenance, not an upgrade step.",
    );
  } else {
    ok(`${sizeText} — within budget`);
  }

  info("\n7) Agent lifecycle hooks");
  const hooks = inspectAgentHookStatus(repo);
  const configuredAgents = hooks.configuredAgents.length ? hooks.configuredAgents.join(", ") : "none";
  if (hooks.state === "active") {
    ok(`ACTIVE — ${hooks.evidenceAgent} observed on Stop; configured: ${configuredAgents} (optional intercept; task gate is deliver)`);
  } else if (hooks.state === "configured") {
    warn(`CONFIGURED — ${configuredAgents}; optional intercept not yet observed. Task acceptance: ${cli} deliver`);
  } else {
    warn(`DEGRADED — configured: ${configuredAgents}; ${hooks.issues.join("; ")}`);
  }

  const guidance = buildHarnessGuidance({ manifest: m, hooks, cli });
  // An ERR above always comes with a required step, like verify.
  guidance.nextActions.unshift(...contextFreshnessActions(freshnessIssues, cli));
  if (problems && !guidance.nextActions.some((action) => action.priority === "required"))
    guidance.nextActions.unshift({
      id: "fix-doctor-problems",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: `Fix the ${problems} doctor problem(s) reported above`,
      reason: "doctor found configuration problems (ERR lines above).",
      commands: [`${cli} doctor --repo .`],
      completion: "doctor reports repository configuration healthy.",
    });
  const visibleActions = opts.details
    ? guidance.nextActions
    : guidance.nextActions.filter((action) => action.priority === "required");
  info("\nNEXT ACTIONS");
  if (!visibleActions.length) ok("nothing required now");
  for (const action of visibleActions) {
    warn(`[${action.priority.toUpperCase()} | ${action.owner.toUpperCase()}] ${action.title}`);
    info(`       why: ${action.reason}`);
    info(`       when: ${action.when}`);
    for (const command of action.commands) info(`       run: ${command}`);
    info(`       done when: ${action.completion}`);
  }
  const hiddenRecommended = guidance.nextActions.length - visibleActions.length;
  if (hiddenRecommended > 0)
    info(`       ${hiddenRecommended} recommended maintenance action(s) hidden; use \`--details\` to view`);

  info("");
  const requiredActions = guidance.nextActions.filter((action) => action.priority === "required");
  if (problems) {
    info(`doctor: ${problems} problem(s) found`);
    if (requiredActions.length) warn(`Harness readiness: INCOMPLETE (${requiredActions.length} required action(s) above)`);
    return 1;
  }
  info("doctor: repository configuration healthy");
  if (requiredActions.length) warn(`Harness readiness: INCOMPLETE (${requiredActions.length} required action(s) above)`);
  else ok("Harness readiness: READY");
  return 0;
}
