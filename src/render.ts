import { HARNESS_LOCK_REL, harnessInvocation } from "./harness-cli";
import type { Manifest } from "./manifest";
import { GEN_HEADER } from "./util";

export interface RenderOptions {
  /** Version from `.agents/harness.lock.json`; entry commands pin it. Rendering stays pure: callers read the lock. */
  harnessVersion?: string | null;
}

/** Safely stringify a manifest value — objects become JSON instead of [object Object]. */
function safeStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function dependencyLines(label: string, items: readonly unknown[], prefix: string): string[] {
  if (items.length === 1) return [`${prefix}${label}: ${safeStr(items[0])}`];
  const indent = prefix ? "  " : "";
  return [`${prefix}${label}:`, ...items.map((item) => `${indent}- ${safeStr(item)}`)];
}

/** Generated tool files. Each returns [relPath, content]. Routing/modules only when present. */
export function renderTargets(m: Manifest, opts: RenderOptions = {}): Array<[string, string]> {
  const targets: Array<[string, string]> = [
    ["AGENTS.md", renderAgentsMd(m, opts)],
    ["CLAUDE.md", renderClaudeMd()],
    [".agents/reference.md", renderReferenceMd(m)],
  ];
  if (m.routing?.length) targets.push([".agents/routing.md", renderRoutingMd(m)]);
  if (m.modules?.length) targets.push([".agents/modules.md", renderModulesMd(m)]);
  return targets;
}

/** AGENTS.md lines, each marked as fixed Harness text or repository content from the manifest. */
function agentsMdLines(m: Manifest, opts: RenderOptions): Array<{ text: string; fixed: boolean }> {
  const id = m.identity;
  // The package is distributed through npx, so a bare `harness-kit` is usually
  // not on PATH (exit 127). Every runnable instruction uses the pinned form.
  const hk = harnessInvocation(opts.harnessVersion);
  const out: Array<{ text: string; fixed: boolean }> = [];
  const content = { push: (...lines: string[]) => out.push(...lines.map((text) => ({ text, fixed: false }))) };
  const fixed = { push: (...lines: string[]) => out.push(...lines.map((text) => ({ text, fixed: true }))) };
  fixed.push(GEN_HEADER(), "");
  content.push(`# ${id.name}`, "");
  if (id.summary) content.push(id.summary, "");

  fixed.push("## Working agreement (read first)", "");
  fixed.push(
    `Harness CLI: \`${hk} <command>\` ` +
      (opts.harnessVersion
        ? `(pinned by \`${HARNESS_LOCK_REL}\`; no global install).`
        : `(no global install; no \`${HARNESS_LOCK_REL}\` version pin yet).`),
    "",
  );
  fixed.push(
    "Generated from `.agents/manifest.yaml`, never hand-edit: `AGENTS.md`, `CLAUDE.md`, `.agents/reference.md` " +
      "(plus `.agents/routing.md` / `.agents/modules.md` when declared). " +
      `Edit the manifest, then run \`${hk} sync\`. Knowledge is hand-authored; \`.agents/hooks/\` belongs to \`install-hooks\`.`,
    "",
  );
  const hasImpactMap = (m.modules ?? []).some((mod) => (mod.owns?.length ?? 0) > 0) || !!m.validation;
  fixed.push("Before you touch code:");
  fixed.push("1. Post a **Task Brief**: what changes, change-type, files/layers touched, how you'll verify.");
  if (m.routing?.length)
    fixed.push("2. Find your change-type in `.agents/routing.md` and read the files it points to; do NOT full-repo grep and guess.");
  else fixed.push("2. Read the relevant files before editing; do NOT full-repo grep and guess.");
  if (hasImpactMap)
    fixed.push(
      `   Prefer \`${hk} task-start\` before editing so later commits stay in deliver scope (without it, deliver uses the worktree diff vs HEAD).`,
    );
  fixed.push("");
  fixed.push("Before you finish:");
  if (hasImpactMap) {
    fixed.push(
      `3. Run \`${hk} deliver\` (checks + verify + stamp). Only \`status=accepted\` (or clean \`no-change\`) means done; on \`needs-work\`, fix and re-run.`,
    );
  } else {
    fixed.push(`3. Run \`${hk} deliver\` (or at least \`${hk} verify\`). Do not claim completion without a passing stamp/verify.`);
  }
  fixed.push(
    "4. In `NEXT ACTIONS` / `nextActions`: do every `required | agent` action yourself; ask the user only for `required | human`; defer `recommended` during unrelated work.",
  );
  fixed.push(
    "5. **Never claim a check you didn't run.** Informational boundaries (packaging, real network, prod upload) are not failures; mention them only when relevant.",
  );
  fixed.push(
    "6. Record what code can't tell an agent (gotcha, decision, fix): update the registered knowledge source in place, " +
      "or add to `.agents/knowledge/` (journal ADR for decisions). Never move/copy existing repo docs to fit a folder; skip one-off noise.",
  );
  fixed.push("");

  if (id.scope_in?.length || id.scope_out?.length) {
    content.push("## Scope");
    if (id.scope_in?.length) content.push("", "In scope:", ...id.scope_in.map((s) => `- ${safeStr(s)}`));
    if (id.scope_out?.length)
      content.push("", "Out of scope (do NOT modify here):", ...id.scope_out.map((s) => `- ${safeStr(s)}`));
    content.push("");
  }

  // Several items get one line each (an item may itself contain commas or
  // semicolons); a single item stays inline instead of a one-entry list.
  if (id.upstream?.length || id.downstream?.length) {
    content.push("## Dependencies");
    if (id.upstream?.length) content.push("", ...dependencyLines("Upstream", id.upstream, ""));
    if (id.downstream?.length) content.push("", ...dependencyLines("Downstream", id.downstream, ""));
    content.push("");
  }

  const allCaps = Object.entries(m.capabilities ?? {});
  const hasExplicitBootstrap = allCaps.some(([, capability]) => capability.bootstrap !== undefined);
  const defaultBootstrap = new Set(["setup", "test", "typecheck", "lint", "build", "verify", "dev"]);
  const caps = allCaps.filter(([verb, capability]) =>
    hasExplicitBootstrap ? capability.bootstrap === true : defaultBootstrap.has(verb),
  );
  if (caps.length) {
    content.push("## Commands", "");
    for (const [verb, c] of caps) {
      const tags = [c.background ? "(long-running)" : "", c.mutating ? "(mutating — confirm first)" : ""]
        .filter(Boolean)
        .join(" ");
      content.push(`- \`${verb}\`: \`${c.run}\`${c.desc ? ` — ${c.desc}` : ""}${tags ? " " + tags : ""}`);
      if (c.example) content.push(`  - example: \`${c.example}\``);
    }
    content.push("");
  }

  if (m.contracts?.length) {
    // Not every repository versions its interfaces; breaking_needs says what a break requires.
    content.push("## Contracts (never break silently)", "");
    for (const c of m.contracts) {
      content.push(`- ${c.id} [${c.kind}]${c.breaking_needs ? ` (breaking -> ${c.breaking_needs})` : ""}: ${c.desc}`);
    }
    content.push("");
  }

  if (m.invariants?.length) {
    content.push("## Invariants (must hold)", "");
    // The id is how scope, routing, and module cards refer to a rule.
    for (const inv of m.invariants) {
      const how = inv.enforcement ? "enforced" : inv.check ? "checked" : "manual";
      content.push(`- \`${inv.id}\`: ${inv.rule} [${how}]`);
    }
    content.push("");
    fixed.push(`Run \`${hk} verify\` to check the enforceable ones.`, "");
  }

  fixed.push("## Knowledge & maps (load on demand)", "");
  if (!(m.knowledge?.length) || m.knowledge.some((knowledge) => (knowledge.root ?? "agents") === "agents"))
    fixed.push("- Harness-owned domain / conventions / decisions: `.agents/knowledge/`");
  if (m.knowledge?.some((knowledge) => knowledge.root === "repo"))
    fixed.push("- Existing repository documents stay in place; use their exact paths from `.agents/reference.md`");
  if (allCaps.length || m.environment?.length || m.knowledge?.length)
    fixed.push("- Full commands, environment, and registered knowledge catalog: `.agents/reference.md`");
  if (m.routing?.length) fixed.push("- Change-type routing (read before editing): `.agents/routing.md`");
  if (m.modules?.length) fixed.push("- Module map + common pitfalls: `.agents/modules.md`");
  if (hasImpactMap) fixed.push(`- Implement -> verify loop (deep guide): run \`${hk} check-loop\``);
  fixed.push("- Tooling adoption log (earn heavier tooling): `.agents/adoption.md`");
  if (m.playbooks?.dir) fixed.push(`- Task playbooks: \`.agents/${m.playbooks.dir}\``);
  fixed.push("");
  return out;
}

export function renderAgentsMd(m: Manifest, opts: RenderOptions = {}): string {
  return agentsMdLines(m, opts).map((line) => line.text).join("\n");
}

// Han and Kana are written without spaces, so whitespace splitting counted a
// whole Chinese paragraph as one word. Each such character counts as half a
// word (about one English word per two characters); Hangul is space-separated
// and splits like other text. Spacing around CJK never changes the count, and a
// token without a letter or digit (a Markdown bullet, "##", "|") is not a word.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const WIDE_PUNCTUATION = /[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/g;

export function countWords(text: string): number {
  const unspaced = text.match(UNSPACED_SCRIPT)?.length ?? 0;
  const rest = text.replace(UNSPACED_SCRIPT, " ").replace(WIDE_PUNCTUATION, " ");
  const words = rest.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  return words + Math.ceil(unspaced / 2);
}

export interface AgentsMdSize {
  lines: number;
  words: number;
  /** Words the repository controls: everything except the fixed Harness working agreement, header, and map. */
  contentWords: number;
  /** contentWords per repository section ("## Invariants (must hold)", ...), largest first. */
  sections: Array<{ heading: string; words: number }>;
}

export function agentsMdSize(m: Manifest, opts: RenderOptions = {}): AgentsMdSize {
  const lines = agentsMdLines(m, opts);
  const text = lines.map((line) => line.text).join("\n");
  const bySection = new Map<string, string[]>();
  let heading = "(title and summary)";
  for (const line of lines) {
    if (line.fixed) continue;
    if (line.text.startsWith("## ")) heading = line.text.slice(3);
    bySection.set(heading, [...(bySection.get(heading) ?? []), line.text]);
  }
  return {
    lines: text.split("\n").length,
    words: countWords(text),
    contentWords: countWords(lines.filter((line) => !line.fixed).map((line) => line.text).join("\n")),
    sections: [...bySection].map(([name, body]) => ({ heading: name, words: countWords(body.join("\n")) })).sort((a, b) => b.words - a.words),
  };
}

/** Full catalog kept out of the bootstrap budget. */
export function renderReferenceMd(m: Manifest): string {
  const L: string[] = [GEN_HEADER(), "", "# Harness reference", ""];
  const caps = Object.entries(m.capabilities ?? {});
  if (caps.length) {
    L.push("## Commands", "");
    for (const [verb, capability] of caps) {
      const tags = [
        capability.bootstrap ? "(bootstrap)" : "",
        capability.background ? "(long-running)" : "",
        capability.mutating ? "(mutating — confirm first)" : "",
      ]
        .filter(Boolean)
        .join(" ");
      L.push(`- \`${verb}\`: \`${capability.run}\`${capability.desc ? ` — ${capability.desc}` : ""}${tags ? ` ${tags}` : ""}`);
      if (capability.example) L.push(`  - example: \`${capability.example}\``);
    }
    L.push("");
  }
  if (m.environment?.length) {
    L.push("## Environment", "");
    for (const variable of m.environment) {
      const flags = [variable.required ? "(required)" : "", variable.secret ? "(secret — never hardcode/commit)" : ""]
        .filter(Boolean)
        .join(" ");
      L.push(`- \`${variable.name}\`${flags ? ` ${flags}` : ""}${variable.desc ? ` — ${variable.desc}` : ""}`);
    }
    L.push("");
  }
  if (m.knowledge?.length) {
    L.push("## Registered knowledge", "");
    for (const knowledge of m.knowledge) {
      const path = knowledge.root === "repo" ? knowledge.path : `.agents/${knowledge.path}`;
      const tags = [knowledge.role ? `role=${knowledge.role}` : "", knowledge.authority ? `authority=${knowledge.authority}` : ""]
        .filter(Boolean)
        .join(", ");
      L.push(`- \`${path}\`${tags ? ` (${tags})` : ""}`);
    }
    L.push("");
  }
  return L.join("\n");
}

/** .agents/routing.md — per change-type navigation. On-demand, not size-budgeted. */
export function renderRoutingMd(m: Manifest): string {
  const L: string[] = [];
  L.push(GEN_HEADER(), "");
  L.push("# Change routing", "");
  L.push("Find the change-type that matches your task and follow that row before editing.", "");
  for (const r of m.routing ?? []) {
    L.push(`## ${r.when}`);
    if (r.read?.length) L.push(`- Read first: ${r.read.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (r.entry?.length) L.push(`- Entry points: ${r.entry.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (r.dont_assume?.length) for (const d of r.dont_assume) L.push(`- Do NOT assume: ${safeStr(d)}`);
    if (r.verify?.length) L.push(`- Minimum verification: ${r.verify.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    L.push("");
  }
  return L.join("\n");
}

/** .agents/modules.md — module cards. On-demand, not size-budgeted. */
export function renderModulesMd(m: Manifest): string {
  const L: string[] = [];
  L.push(GEN_HEADER(), "");
  L.push("# Module map", "");
  for (const mod of m.modules ?? []) {
    L.push(`## ${mod.name} — ${mod.role}`);
    if (mod.entry?.length) L.push(`- Entry: ${mod.entry.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (mod.owns?.length) L.push(`- Owns (prod): ${mod.owns.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (mod.tests?.length) L.push(`- Tests: ${mod.tests.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (mod.checks?.length) L.push(`- Checks: ${mod.checks.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (mod.gates?.length) L.push(`- Validation gates: ${mod.gates.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (mod.test_touch) L.push(`- Test touch: \`${safeStr(mod.test_touch)}\``);
    if (mod.playbook) L.push(`- Playbook: \`${safeStr(mod.playbook)}\``);
    if (mod.upstream?.length) L.push(...dependencyLines("Upstream", mod.upstream, "- "));
    if (mod.downstream?.length) L.push(...dependencyLines("Downstream", mod.downstream, "- "));
    if (mod.must_know?.length) for (const k of mod.must_know) L.push(`- Must know: ${safeStr(k)}`);
    if (mod.pitfalls?.length) for (const p of mod.pitfalls) L.push(`- Pitfall: ${safeStr(p)}`);
    L.push("");
  }
  if (m.validation?.gates && Object.keys(m.validation.gates).length) {
    L.push("# Validation gates", "");
    L.push("Project-defined mandatory proof obligations. Profiles may replace ordinary module checks, but they cannot bypass these gates.", "");
    for (const [id, gate] of Object.entries(m.validation.gates)) {
      L.push(`## ${safeStr(id)}${gate.desc ? ` — ${safeStr(gate.desc)}` : ""}`);
      L.push(`- Mandatory checks: ${gate.checks.map((check) => `\`${safeStr(check)}\``).join(", ")}`);
      if (gate.acceptance) {
        L.push(`- Acceptance tests: ${gate.acceptance.tests.map((test) => `\`${safeStr(test)}\``).join(", ")}`);
        L.push(`- Acceptance test touch: \`${safeStr(gate.acceptance.test_touch)}\``);
      }
      L.push("");
    }
  }
  return L.join("\n");
}

export function renderClaudeMd(): string {
  // Claude Code reads the first-line @import; keep it first.
  return `@AGENTS.md\n\n${GEN_HEADER()}\n`;
}
