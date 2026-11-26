import type { AgentHookStatus } from "./hook-status";
import type { Manifest } from "./manifest";
import type { ContextFreshnessIssue } from "./state";

export type VerificationGapClassification = "recommended" | "informational";

export type VerificationGapKind =
  | "manual-invariant"
  | "unenforced-invariant"
  | "manual-contract"
  | "unchecked-contract"
  | "mutating-capability"
  | "background-capability";

export interface VerificationGapDetail {
  id: string;
  kind: VerificationGapKind;
  scope: string;
  classification: VerificationGapClassification;
  title: string;
  reason: string;
  when: string;
  /** Kept byte-for-byte compatible with the v1 `gaps: string[]` field. */
  legacyText: string;
}

export interface VerificationGapSummary {
  total: number;
  recommended: number;
  informational: number;
}

export type HarnessActionPriority = "required" | "recommended";
export type HarnessActionOwner = "agent" | "human";
export type HarnessActionTiming = "before-finish" | "before-harness-ready" | "harness-maintenance";

export interface HarnessNextAction {
  id: string;
  priority: HarnessActionPriority;
  owner: HarnessActionOwner;
  when: HarnessActionTiming;
  title: string;
  reason: string;
  commands: string[];
  completion: string;
}

export interface EvidenceGuidanceInput {
  found: boolean;
  stale?: boolean;
  runChecksValid?: boolean;
  verifyPassed?: boolean;
  valid?: boolean;
}

export interface HarnessGuidance {
  gapDetails: VerificationGapDetail[];
  gapSummary: VerificationGapSummary;
  nextActions: HarnessNextAction[];
}

export interface HarnessGuidanceInput {
  manifest?: Manifest;
  hooks?: AgentHookStatus;
  evidence?: EvidenceGuidanceInput;
  /** Runnable CLI prefix for action commands, e.g. the lock-pinned npx invocation. */
  cli?: string;
}

function gap(
  kind: VerificationGapKind,
  scope: string,
  classification: VerificationGapClassification,
  title: string,
  reason: string,
  when: string,
  legacyText: string,
): VerificationGapDetail {
  return { id: `${kind}:${scope}`, kind, scope, classification, title, reason, when, legacyText };
}

function declaredVerificationGaps(manifest: Manifest): VerificationGapDetail[] {
  const gaps: VerificationGapDetail[] = [];
  for (const invariant of manifest.invariants ?? []) {
    if (invariant.manual) {
      gaps.push(gap(
        "manual-invariant",
        invariant.id,
        "informational",
        `Review invariant ${invariant.id} when relevant`,
        invariant.rule,
        "Only when a change may affect this declared rule.",
        `invariant ${invariant.id}: manual, not machine-enforced — ${invariant.rule}`,
      ));
    } else if (!invariant.enforcement && !invariant.check) {
      gaps.push(gap(
        "unenforced-invariant",
        invariant.id,
        "recommended",
        `Add enforcement for invariant ${invariant.id}`,
        invariant.rule,
        "During onboarding or a dedicated Harness-maintenance task, not an unrelated product change.",
        `invariant ${invariant.id}: no enforcement/check declared — ${invariant.rule}`,
      ));
    }
  }

  for (const contract of manifest.contracts ?? []) {
    if (contract.check || contract.snapshot) continue;
    const legacyText =
      `contract ${contract.id}: no automatic check` +
      (contract.manual_verify ? ` — verify by hand: ${contract.manual_verify}` : "");
    if (contract.manual_verify) {
      gaps.push(gap(
        "manual-contract",
        contract.id,
        "informational",
        `Verify contract ${contract.id} when it changes`,
        contract.manual_verify,
        "Only when this contract is changed or before the release that carries it.",
        legacyText,
      ));
    } else {
      gaps.push(gap(
        "unchecked-contract",
        contract.id,
        "recommended",
        `Add a check or manual procedure for contract ${contract.id}`,
        "The contract has neither an automatic check nor a declared manual verification procedure.",
        "During onboarding or a dedicated Harness-maintenance task.",
        legacyText,
      ));
    }
  }

  for (const [verb, capability] of Object.entries(manifest.capabilities ?? {})) {
    if (capability.mutating) {
      gaps.push(gap(
        "mutating-capability",
        verb,
        "informational",
        `Run ${verb} only when deliberately requested`,
        `The command \`${capability.run}\` can change external or repository state, so verify never runs it automatically.`,
        "Only when the task explicitly requires this capability.",
        `capability ${verb} (\`${capability.run}\`): mutating — not run here, verify deliberately`,
      ));
    } else if (capability.background) {
      gaps.push(gap(
        "background-capability",
        verb,
        "informational",
        `Exercise ${verb} only when its runtime is relevant`,
        `The command \`${capability.run}\` is long-running, so verify does not start it.`,
        "Only for tasks that need the live service or background process.",
        `capability ${verb} (\`${capability.run}\`): long-running — not run in this gate`,
      ));
    }
  }
  return gaps;
}

function automationAction(gaps: VerificationGapDetail[], cli: string): HarnessNextAction | null {
  const recommended = gaps.filter((item) => item.classification === "recommended");
  if (!recommended.length) return null;
  return {
    id: "improve-verification-automation",
    priority: "recommended",
    owner: "agent",
    when: "harness-maintenance",
    title: `Improve ${recommended.length} verification declaration(s)`,
    reason:
      "These declarations have no executable check or complete manual procedure. They do not invalidate this run, but they weaken future coverage.",
    commands: [`${cli} verify --repo . --details`],
    completion:
      "Each declaration has a real enforcement/check, or an explicit manual procedure when automation is genuinely impossible.",
  };
}

function evidenceOnlyIssue(issue: string): boolean {
  return /latest lifecycle evidence|start a new Agent session/.test(issue);
}

function unsafeHookIssue(issue: string): boolean {
  return /not valid hook JSON|not a safe .*regular file|unknown hooks shape|must be an array|foreign|belongs to another worktree/.test(
    issue,
  );
}

function hookActions(hooks: AgentHookStatus, cli: string): HarnessNextAction[] {
  // Hooks are an optional session intercept. Delivery quality is driven by `deliver` stamps,
  // not by proving hookActive in a fresh session — never require "open a new conversation".
  if (hooks.state === "active") return [];
  const configured = hooks.configuredAgents.join(",");

  const unsafe = hooks.issues.filter(unsafeHookIssue);
  if (unsafe.length) {
    return [{
      id: "review-lifecycle-hook-conflict",
      priority: "recommended",
      owner: "human",
      when: "harness-maintenance",
      title: "Optional: resolve Hook configuration conflict for session intercept",
      reason:
        "Harness found a Hook file or registration it cannot safely replace: " + unsafe.join("; ") +
        `. Delivery still works via ${cli} deliver without hooks.`,
      commands: [],
      completion:
        "User approves one exact proposed change, or accepts cooperative deliver-only workflow.",
    }];
  }

  if (hooks.state === "configured" || (hooks.configuredAgents.length > 0 && hooks.issues.every(evidenceOnlyIssue))) {
    return [{
      id: "optional-lifecycle-hook-observation",
      priority: "recommended",
      owner: "agent",
      when: "harness-maintenance",
      title: "Optional: observe lifecycle Hook on a later Stop",
      reason:
        `Hooks are configured for ${configured || "the current Agent"} but not yet observed. This does not block delivery — use ${cli} deliver for task acceptance.`,
      commands: [`${cli} deliver --repo .`, `${cli} evidence --repo . --json`],
      completion: "Deliver stamp is valid; hook observation is optional.",
    }];
  }

  if (!hooks.configuredAgents.length) {
    return [{
      id: "optional-install-lifecycle-hooks",
      priority: "recommended",
      owner: "agent",
      when: "harness-maintenance",
      title: "Optional: install Agent Stop intercept for session-level loops",
      reason:
        `Without Stop hooks, agents must run ${cli} deliver cooperatively. Install hooks only when the host supports them.`,
      commands: [
        `${cli} deliver --repo .`,
        `${cli} install-hooks --repo . --stop --agents ${configured || "<current-agent>"}`,
      ],
      completion: "Deliver works without hooks; hooks only add session intercept when the host fires Stop.",
    }];
  }

  return [{
    id: "repair-lifecycle-hooks",
    priority: "recommended",
    owner: "agent",
    when: "harness-maintenance",
    title: "Optional: repair Agent lifecycle Hook configuration",
    reason: `Hook configuration is incomplete or degraded. Delivery still uses ${cli} deliver.`,
    commands: [
      `${cli} install-hooks --repo . --stop --agents ${configured}`,
      `${cli} deliver --repo .`,
    ],
    completion: "Hooks install cleanly or the team accepts deliver-only cooperative mode.",
  }];
}

function evidenceActions(evidence: EvidenceGuidanceInput, cli: string): HarnessNextAction[] {
  if (!evidence.found) {
    return [{
      id: "record-delivery-evidence",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: "Accept this change with deliver",
      reason: "No delivery stamp exists for the current worktree/session.",
      commands: [`${cli} deliver --repo .`, `${cli} evidence --repo . --json`],
      completion: "deliver reports status=accepted (or no-change) and evidence stamp is valid.",
    }];
  }
  if (evidence.stale) {
    return [{
      id: "refresh-stale-delivery-evidence",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: "Re-run deliver for the current code",
      reason: "The saved green stamp belongs to an older code fingerprint.",
      commands: [`${cli} deliver --repo .`, `${cli} evidence --repo . --json`],
      completion: "Stamp is no longer stale and deliver reports accepted.",
    }];
  }
  if (!evidence.runChecksValid) {
    return [{
      id: "complete-run-checks",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: "Complete impact-driven delivery checks",
      reason: "The selected checks did not produce valid evidence for the current code.",
      commands: [`${cli} deliver --repo .`, `${cli} evidence --repo . --json`],
      completion: "deliver reports accepted and stamp runChecksValid: true.",
    }];
  }
  if (!evidence.verifyPassed || !evidence.valid) {
    return [{
      id: "complete-verify",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: "Complete delivery verification",
      reason: "Change checks passed, but matching verify evidence is missing or failed.",
      commands: [`${cli} deliver --repo .`, `${cli} evidence --repo . --json`],
      completion: "deliver reports accepted and stamp valid: true.",
    }];
  }
  return [];
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./@:+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `--path <knowledge.path>` or `--module <name>`, exactly as record-context-review expects it. */
export function contextReviewSelector(issue: Pick<ContextFreshnessIssue, "kind" | "target">): string {
  return issue.kind === "knowledge" ? `--path ${shellArg(issue.target)}` : `--module ${shellArg(issue.target)}`;
}

/** Only a fresh review clears these; source-missing / orphan-review need a manifest fix first. */
export function reviewClearsIssue(issue: Pick<ContextFreshnessIssue, "code">): boolean {
  return issue.code !== "source-missing" && issue.code !== "orphan-review";
}

/**
 * Required follow-up for blocking context-freshness issues this change owns, so
 * a failing verify never ends with "nothing required now".
 */
export function contextFreshnessActions(issues: readonly ContextFreshnessIssue[], cli: string): HarnessNextAction[] {
  const blocking = issues.filter((issue) => issue.severity === "blocking" && !issue.inherited);
  const actions: HarnessNextAction[] = [];
  const reviewable = blocking.filter(reviewClearsIssue);
  if (reviewable.length) {
    const sources = [...new Set(reviewable.flatMap((issue) => issue.changedSources))].sort();
    actions.push({
      id: "record-context-reviews",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: `Re-review ${reviewable.length} stale context item(s), then record the review`,
      reason:
        `${reviewable.map((issue) => `${issue.key} (${issue.code})`).join(", ")}` +
        (sources.length ? `; changed sources: ${sources.join(", ")}` : "") +
        ". Re-read each knowledge document or module card against those sources, fix it in place if it is wrong, and only then record the review.",
      commands: [
        `${cli} record-context-review --repo . ${reviewable.map(contextReviewSelector).join(" ")} --reason "<what you re-checked>"`,
      ],
      completion: "verify reports no blocking context freshness issue.",
    });
  }
  const declaration = blocking.filter((issue) => !reviewClearsIssue(issue));
  if (declaration.length) {
    actions.push({
      id: "fix-context-declarations",
      priority: "required",
      owner: "agent",
      when: "before-finish",
      title: `Fix ${declaration.length} context declaration(s) in .agents/manifest.yaml`,
      reason: declaration.map((issue) => `${issue.key}: ${issue.reason}`).join("; "),
      commands: [],
      completion: "binds/entry name existing files (or the retired review is removed deliberately) and verify passes.",
    });
  }
  return actions;
}

export function buildHarnessGuidance(input: HarnessGuidanceInput): HarnessGuidance {
  const cli = input.cli ?? "harness-kit";
  const gapDetails = input.manifest ? declaredVerificationGaps(input.manifest) : [];
  const nextActions = [
    ...(input.evidence ? evidenceActions(input.evidence, cli) : []),
    ...(input.hooks ? hookActions(input.hooks, cli) : []),
  ];
  const improvement = automationAction(gapDetails, cli);
  if (improvement) nextActions.push(improvement);
  return {
    gapDetails,
    gapSummary: {
      total: gapDetails.length,
      recommended: gapDetails.filter((item) => item.classification === "recommended").length,
      informational: gapDetails.filter((item) => item.classification === "informational").length,
    },
    nextActions,
  };
}
