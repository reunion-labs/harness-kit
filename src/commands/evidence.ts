import { inspectDeliveryStamp, type DeliveryStamp } from "../delivery";
import { buildHarnessGuidance, type HarnessNextAction } from "../guidance";
import { repoHarnessInvocation } from "../harness-cli";
import {
  agentHookConfigurationFingerprint,
  inspectAgentHookStatus,
  lifecycleEvidencePassed,
  type AgentHookStatus,
} from "../hook-status";
import {
  inspectValidationEvidenceFreshness,
  readLatestHookValidationSession,
  readLatestValidationSession,
  readValidationSession,
  type HookAgent,
  type StopObservation,
  type ValidationSession,
} from "../validation-state";
import { err, info, ok, warn } from "../util";

export interface EvidenceOpts {
  json?: boolean;
  session?: string;
}

/** What the installed lifecycle hooks have demonstrably done for one Agent session. */
export interface LifecycleProof {
  agent: Exclude<HookAgent, "manual">;
  /** Harness token for this session: sha256 of agent and host session id. */
  session: string;
  /** The client's own session id, so a lifecycle record can be matched to a real conversation. */
  hostSessionId: string;
  sessionStartedAt: string;
  baseSha: string | null;
  /** The runner and client config bound at SessionStart are still the installed ones. */
  configurationCurrent: boolean;
  /** Latest Stop observed for this session; null when no Stop has run since SessionStart. */
  stop: StopObservation | null;
  /** run-checks: execute-mode Stop ran the gates; deliver-stamp: a thin Stop accepted this deliver stamp. */
  evidenceSource: "run-checks" | "deliver-stamp" | null;
  /** That gate evidence passed run-checks + verify when the Stop accepted it. */
  evidencePassed: boolean;
  /** It still matches the current change (later edits make it older, not invalid proof). */
  evidenceCurrent: boolean;
  /** evidencePassed and evidenceCurrent. */
  evidenceValid: boolean;
  /** Same rule as the ACTIVE hook state: current configuration and passed gate evidence. */
  active: boolean;
}

function lifecycleProof(repo: string, session: ValidationSession | null): LifecycleProof | null {
  if (!session || session.agent === "manual") return null;
  const configurationCurrent =
    !!session.hookConfigFingerprint && agentHookConfigurationFingerprint(repo, session.agent) === session.hookConfigFingerprint;
  const evidence = session.lastEvidence;
  const evidencePassed = !!evidence && lifecycleEvidencePassed(evidence);
  const evidenceCurrent = !!evidence && !inspectValidationEvidenceFreshness(repo, evidence).stale;
  return {
    agent: session.agent,
    session: session.token,
    hostSessionId: session.sessionId,
    sessionStartedAt: session.createdAt,
    baseSha: session.baseSha,
    configurationCurrent,
    stop: session.lastStop ?? null,
    evidenceSource: evidence ? evidence.source ?? "run-checks" : null,
    evidencePassed,
    evidenceCurrent,
    evidenceValid: evidencePassed && evidenceCurrent,
    active: configurationCurrent && evidencePassed,
  };
}

function safeLifecycleProof(repo: string, session: ValidationSession | null | undefined): LifecycleProof | null {
  try {
    return lifecycleProof(repo, session === undefined ? readLatestHookValidationSession(repo) : session);
  } catch {
    return null;
  }
}

function describeLifecycle(lifecycle: LifecycleProof | null): string {
  if (!lifecycle) return "lifecycle: no SessionStart recorded by an installed hook";
  const stop = lifecycle.stop
    ? `last Stop ${lifecycle.stop.decision} (${lifecycle.stop.mode}, ${lifecycle.stop.reason}) at ${lifecycle.stop.at}`
    : "no Stop observed yet (the Stop that ends this turn judges the stamp and, if it accepts it, proves the hook)";
  const config = lifecycle.configurationCurrent ? "" : "; hook configuration changed since SessionStart";
  const older = lifecycle.evidencePassed && !lifecycle.evidenceCurrent ? "; its gate evidence covers an earlier change" : "";
  const rebound = lifecycle.stop?.rebound ? "; rebound to the hook configuration refreshed during the session" : "";
  return (
    `lifecycle: ${lifecycle.agent} session ${lifecycle.hostSessionId} started ${lifecycle.sessionStartedAt}; ${stop}${config}${rebound}${older}; ` +
    `hookActive: ${lifecycle.active ? "yes" : "no"}`
  );
}

function safeHookStatus(repo: string): AgentHookStatus {
  try {
    return inspectAgentHookStatus(repo);
  } catch (error) {
    return {
      state: "degraded",
      configuredAgents: [],
      issues: [`cannot inspect Agent lifecycle hooks: ${(error as Error).message}`],
    };
  }
}

function printNextActions(actions: HarnessNextAction[]): void {
  info("\nNEXT ACTIONS");
  if (!actions.length) {
    ok("nothing required now");
    return;
  }
  for (const action of actions) {
    warn(`[${action.priority.toUpperCase()} | ${action.owner.toUpperCase()}] ${action.title}`);
    info(`       why: ${action.reason}`);
    info(`       when: ${action.when}`);
    for (const command of action.commands) info(`       run: ${command}`);
    info(`       done when: ${action.completion}`);
  }
}

export function evidenceCmd(repo: string, opts: EvidenceOpts = {}): number {
  let session;
  try {
    session = opts.session ? readValidationSession(repo, opts.session) : readLatestValidationSession(repo);
  } catch (error) {
    err(`cannot read validation evidence: ${(error as Error).message}`);
    return 1;
  }
  const hooks = safeHookStatus(repo);
  // An explicit --session is reported on its own; otherwise lifecycle proof
  // comes from the latest hook session, which a thin Stop never makes "latest".
  const lifecycle = safeLifecycleProof(repo, opts.session ? session : undefined);
  if (!session?.lastEvidence) {
    const guidance = buildHarnessGuidance({ hooks, evidence: { found: false }, cli: repoHarnessInvocation(repo) });
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            schema: "ai-harness/evidence/v1",
            found: false,
            hooks,
            hookActive: lifecycle?.active ?? false,
            hookActiveSource: lifecycle?.active ? "lifecycle" : null,
            lifecycle,
            nextActions: guidance.nextActions,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      warn("no validation evidence recorded for this worktree/session");
      info(describeLifecycle(lifecycle));
      printNextActions(guidance.nextActions.filter((action) => action.priority === "required"));
      warn(`Harness readiness: INCOMPLETE (${guidance.nextActions.filter((action) => action.priority === "required").length} required action(s) above)`);
    }
    return 1;
  }

  // `agent` / `createdAt` describe this evidence: who ran the delivery and when
  // it was written. A deliver an Agent ran from its own shell lands in the
  // worktree's one manual record (`session`, shared by every manual deliver
  // here), but belongs to that Agent session. Hook proof lives in `lifecycle`.
  const deliveredIn = session.agent === "manual" ? session.lastEvidence.deliveredIn ?? null : null;
  const deliveredBy = deliveredIn?.agent ?? session.agent;
  const body = {
    schema: "ai-harness/evidence/v1",
    found: true,
    session: session.token,
    agent: deliveredBy,
    createdAt: session.lastEvidence.createdAt,
    record: {
      kind: session.agent !== "manual" ? "lifecycle" : deliveredIn ? "agent-deliver" : "manual-deliver",
      session: session.token,
      agent: deliveredBy,
      hostSessionId: session.agent === "manual" ? deliveredIn?.hostSessionId ?? null : session.sessionId,
      deliveredIn,
      createdAt: session.lastEvidence.createdAt,
      sessionCreatedAt: session.createdAt,
    },
    initialDirty: session.initialDirty,
    evidence: session.lastEvidence,
  };
  const evidence = session.lastEvidence;
  const freshness = inspectValidationEvidenceFreshness(repo, evidence);
  const { currentFingerprint, currentPlanFingerprint, stale } = freshness;
  const runChecksValid =
    (evidence.runChecksStatus !== undefined ? evidence.runChecksStatus !== "not-verified" : evidence.ok && evidence.status !== "not-verified") &&
    !stale;
  const valid = runChecksValid && evidence.verifyPassed === true;
  const recordHookConfigurationCurrent = session.agent !== "manual" && !!session.hookConfigFingerprint &&
    agentHookConfigurationFingerprint(repo, session.agent) === session.hookConfigFingerprint;
  const recordProvesHooks = session.agent !== "manual" && lifecycleEvidencePassed(evidence) && recordHookConfigurationCurrent;
  const hookActive = (lifecycle?.active ?? false) || recordProvesHooks;
  // A manual record never binds a hook configuration, so the top-level flag
  // follows the session that is the hook proof instead of reading false beside
  // a current lifecycle.
  const hookConfigurationCurrent = lifecycle ? lifecycle.configurationCurrent : recordHookConfigurationCurrent;
  const hookActiveSource: "lifecycle" | "latest-record" | null = lifecycle?.active
    ? "lifecycle"
    : recordProvesHooks
      ? "latest-record"
      : null;
  const stamp: DeliveryStamp = inspectDeliveryStamp(repo);
  const guidance = buildHarnessGuidance({
    hooks,
    evidence: { found: true, stale, runChecksValid, verifyPassed: evidence.verifyPassed, valid },
    cli: repoHarnessInvocation(repo),
  });
  const result = {
    ...body,
    runChecksValid,
    valid,
    stamp,
    hookActive,
    hookActiveSource,
    hookConfigurationCurrent,
    lifecycle,
    stale,
    currentFingerprint,
    currentPlanFingerprint,
    fingerprintStale: freshness.fingerprintStale,
    planStale: freshness.planStale,
    refreshError: freshness.error,
    hooks,
    nextActions: guidance.nextActions,
  };
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return valid ? 0 : 1;
  }

  if (valid) ok(`stamp: ${stamp.status}`);
  else if (stale) err("stale stamp — the change no longer matches this record");
  else if (evidence.verifyPassed !== true) err("delivery stamp incomplete — matching verify result is missing or failed");
  else err(evidence.status);
  info(`session: ${session.token}${session.agent === "manual" ? " (this worktree's deliver record)" : ""}`);
  info(`agent: ${deliveredBy}`);
  info(`recorded: ${evidence.createdAt}`);
  if (deliveredIn)
    info(
      `stamp source: deliver run by ${deliveredIn.agent} session ${deliveredIn.hostSessionId} (its task record scoped this change) — ` +
        'a command, not hook proof; see "hook proof" below',
    );
  else if (session.agent === "manual") info('stamp source: deliver/manual — this record is not hook proof; see "hook proof" below');
  info(`base: ${evidence.requestedBase} -> ${evidence.resolvedBase ?? "empty tree"}`);
  info(`fingerprint: ${evidence.fingerprint}`);
  if (session.initialDirty.length) info(`dirty at task/session start: ${session.initialDirty.join(", ")}`);
  if (evidence.verifyPassed !== undefined) info(`verify: ${evidence.verifyPassed ? "passed" : "failed"}`);
  else err("verify: no matching result was recorded");
  if (freshness.error) err(`cannot refresh current validation plan: ${freshness.error}`);
  info(`checks: ${evidence.checks.map((check) => `${check.id}:${check.status}`).join(", ") || "(none)"}`);
  if (evidence.gates?.length) info(`validation gates: ${evidence.gates.join(", ")}`);
  if (evidence.waivers.length) {
    info("waivers:");
    for (const waiver of evidence.waivers) warn(`${waiver.kind}:${waiver.where} — ${waiver.reason}`);
  }
  if (evidence.errors.length) {
    info("errors:");
    for (const message of evidence.errors) err(message);
  }
  if (hooks.configuredAgents.length) {
    info(`session intercept: ${hooks.state} (configured: ${hooks.configuredAgents.join(",")})`);
    info(describeLifecycle(lifecycle));
  } else {
    info("session intercept: none (cooperative deliver only)");
  }
  info(`hook proof (hookActive): ${hookActive ? `yes, from the ${hookActiveSource === "lifecycle" ? "lifecycle session" : "latest record"}` : "no"}`);
  const requiredActions = guidance.nextActions.filter((action) => action.priority === "required");
  printNextActions(requiredActions);
  if (!valid) warn(`Delivery stamp: NOT READY (${requiredActions.length} required action(s) above)`);
  else ok("Delivery stamp: READY");
  return valid ? 0 : 1;
}
