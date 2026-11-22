import { createHash } from 'node:crypto';
import { teamAssistantForConversation } from '../assistant-resources.js';
import { PRODUCTION_RULE_ID } from './production-rule.js';
import { recordAuditEvent } from "../audit.js";
import { getHarness } from "../harnesses.js";
import { systemOneFetch } from "../classifiers/relay-key.js";
import { systemDecisionKeyOrRelay } from "../decision-relay-proxy.js";
import { genericSecretEnvironment } from "../secrets.js";
import type { HarnessId } from "../types.js";
import { isGuardianExempt, runGuardianFix } from "./fix.js";
import { localLayaUrl } from "./laya.js";
import { askGuardianModel, jevTarget, layaTarget, type GuardianModelTarget } from "./model.js";
import { announceGuardianBlock, announceGuardianWarning, guardianActionAllowed, REVIEW_TIMEOUT_MS, requestGuardianReview } from "./reviews.js";
import { guardianBypassed } from "./bypass.js";
import { guardianCommandPolicy, guardianCommandText } from './commands.js';
import { ruleApplies, ruleOutcome, worstOutcome, type GuardianRequest, type GuardianRule, type RuleOutcome } from "./rules.js";
import { fetchThroughRelay } from "./relay-model.js";
import { guardianGroups, productionGuard, type GuardianGroup } from "./settings.js";

export interface GuardianIdentity {
  projectId: string;
  conversationId: string;
  harness: HarnessId;
  cwd: string;
  /** Whether the agent accepts changed tool arguments. Kiro can only allow or reject a call. */
  canReplaceTool: boolean;
  /** The run's stop signal: stopping the turn answers an open review with "block". */
  signal?: AbortSignal;
}

export type GuardianVerdict =
  | { action: "continue" }
  | { action: "block"; reason: string }
  /** Go ahead with these arguments or this text instead. */
  | { action: "replace"; input?: Record<string, unknown>; text?: string };

const MAX_FIX_ATTEMPTS = 2;

interface Finding { group: GuardianGroup; rule: GuardianRule; probability: number; outcome: RuleOutcome; model: string }

function knownSecrets(projectId: string): string[] {
  // File-backed variables hold a path, not the secret.
  return Object.values(genericSecretEnvironment(projectId)).filter((value): value is string => typeof value === "string" && !value.startsWith("/"));
}

/** A relay's Jev rules are asked through that relay; other Jev checks borrow a relay's decision model when this machine has no key. */
async function modelRoute(group: GuardianGroup, projectId: string): Promise<{ target: GuardianModelTarget; fetchImpl?: typeof fetch }> {
  if (group.model === "jev" && group.relayNodeId) return { target: jevTarget(""), fetchImpl: fetchThroughRelay(group.relayNodeId) };
  if (group.model === "jev") return { target: jevTarget(await systemDecisionKeyOrRelay("typesafe")), fetchImpl: systemOneFetch };
  return { target: await modelTarget(group, projectId) };
}

async function modelTarget(group: GuardianGroup, projectId: string): Promise<GuardianModelTarget> {
  if (group.model === "laya-local") return layaTarget(await localLayaUrl(), undefined, true);
  return layaTarget(group.layaUrl, genericSecretEnvironment(projectId).LAYA_API_KEY, false);
}

/** The state the model judges: the tool call with its arguments, or the content itself. */
function modelState(identity: GuardianIdentity, request: GuardianRequest): string {
  const agent = getHarness(identity.harness).label;
  return request.kind === "tool"
    ? JSON.stringify({ about: `A tool call the coding agent ${agent} is about to run`, workingDirectory: identity.cwd, tool: request.tool, arguments: request.input })
    : JSON.stringify({ about: `Content about to be sent to an AI model: ${request.source}`, content: request.text });
}

/** Every applicable rule's answer. A model that cannot answer blocks the action. */
async function evaluate(identity: GuardianIdentity, groups: GuardianGroup[], request: GuardianRequest): Promise<{ findings: Finding[]; failure?: string }> {
  const state = modelState(identity, request);
  const results = await Promise.all(groups.map(async (group) => {
    const rules = group.rules.filter((rule) => ruleApplies(rule, request));
    const startOfTurn = request.kind === 'outgoing' && request.source === "the user's message";
    const probe = !rules.length && startOfTurn && group.rules.some(rule => rule.enabled);
    if (!rules.length && !probe) return { findings: [] as Finding[] };
    const questions = probe ? { ready: 'Does the state say ready?' } : Object.fromEntries(rules.map(rule => [rule.id, rule.question]));
    const fallback = group.model === 'jev' ? (group.layaUrl ? 'laya-remote' : 'laya-local') : 'jev';
    const errors: string[] = [];
    for (const model of [group.model, fallback] as const) {
      try {
        const { target, fetchImpl } = await modelRoute({ ...group, model }, identity.projectId);
        const answers = await askGuardianModel(target, probe ? 'ready' : state, questions, fetchImpl, group.relayNodeId ?? identity.projectId, !startOfTurn);
        if (errors.length) announceGuardianWarning(identity.projectId, identity.conversationId, `${group.source}: ${errors[0]}. Using ${target.label} for this check.`);
        return { findings: rules.map(rule => ({ group, rule, probability: answers[rule.id], outcome: ruleOutcome(rule, answers[rule.id]), model: target.label })) };
      } catch (error) {
        errors.push(`${model === 'jev' ? 'Jev' : 'Laya'} unavailable: ${(error as Error).message}`);
      }
    }
    return { findings: [] as Finding[], failure: `${group.source}: ${errors.join('; ')}` };
  }));
  const failure = results.map((result) => result.failure).filter(Boolean).join("; ");
  return { findings: results.flatMap((result) => result.findings), ...(failure ? { failure } : {}) };
}

function what(request: GuardianRequest): string {
  if (request.kind === "outgoing") return `content (${request.source})`;
  return request.category === "commands" ? "command" : request.category === "file-changes" ? "file change" : `${request.tool} call`;
}

const percent = (probability: number) => `${Math.round(probability * 100)}%`;
const describe = (finding: Finding) => `"${finding.rule.name}"${finding.group.relay ? ` (${finding.group.source})` : ""}: ${finding.rule.question} ${finding.model} answered yes at ${percent(finding.probability)}`;

function reviewTitle(identity: GuardianIdentity, request: GuardianRequest): string {
  const agent = getHarness(identity.harness).label;
  if (request.kind === "outgoing") return `${agent} is about to send ${request.source} to the AI`;
  if (request.category === "commands") return `${agent} wants to run a command`;
  if (request.category === "file-changes") return `${agent} wants to change a file`;
  return `${agent} wants to use ${request.tool}`;
}

function reviewSubject(request: GuardianRequest): string {
  if (request.kind === "outgoing") return request.text;
  const command = guardianCommandText(request.input);
  if (request.category === "commands" && command) return command;
  return JSON.stringify(request.input, null, 2);
}

function audit(identity: GuardianIdentity, request: GuardianRequest, outcome: string, findings: Finding[], waited?: { waitedSeconds: number; timedOut: boolean }): void {
  // Never the content itself: what Guardian caught is exactly what must not be stored.
  recordAuditEvent({
    eventType: `guardian.${outcome}`, actorType: "system", entityType: "conversation", entityId: identity.conversationId,
    details: { projectId: identity.projectId, agent: identity.harness, checked: request.kind === "tool" ? request.tool : request.source, rules: findings.map(({ rule }) => rule.name).join(", ") || null, ...waited },
  });
}

/** Applies the fixes of the rules that asked for one. Undefined when a fix cannot be made here. */
async function applyFixes(identity: GuardianIdentity, request: GuardianRequest, findings: Finding[]): Promise<GuardianRequest | undefined> {
  if (request.kind === "tool" && !identity.canReplaceTool) return undefined;
  let next = request;
  for (const finding of findings.filter((item) => item.outcome === "fix")) {
    const fixed = await runGuardianFix(finding.rule.fix, next, { ...identity, secrets: knownSecrets(identity.projectId) }).catch(() => undefined);
    if (!fixed) return undefined;
    next = fixed;
  }
  return next;
}

/**
 * Decides one agent action or one piece of content bound for the model. Every rule of every group that
 * applies is asked in one request per group. A block anywhere wins; user approval never overrides it.
 */
export async function checkGuardian(identity: GuardianIdentity, original: GuardianRequest): Promise<GuardianVerdict> {
  if (guardianBypassed(identity.projectId, identity.conversationId)) return { action: 'continue' };
  const commandPolicy = guardianCommandPolicy(original, identity.cwd);
  if (commandPolicy === 'allow') return { action: 'continue' };
  const team = !!teamAssistantForConversation(identity.projectId, identity.conversationId);
  const effectCapable = original.kind === 'tool' && (original.category === 'commands' || original.category === 'file-changes');
  if (team && effectCapable && await productionGuard(identity.projectId) !== 'on') return announced(identity, 'Production-capable team operation blocked: production Guardian guard is unavailable.');
  const exempt = !team && isGuardianExempt(identity.projectId, identity.conversationId);
  const groups = (await guardianGroups(identity.projectId)).filter(group => group.relay || !exempt);
  // Team Pi retains write/edit without a shell. The mandatory production rule checks those effects too.
  if (team && effectCapable) for (const group of groups) group.rules = group.rules.map(rule => rule.id === PRODUCTION_RULE_ID ? { ...rule, check: 'all' } : rule);
  if (!(original.kind === 'outgoing' && original.source === "the user's message") && !groups.some((group) => group.rules.some((rule) => ruleApplies(rule, original)))) return { action: "continue" };
  if (commandPolicy === 'block') return announced(identity, 'Guardian blocked deletion of a protected branch (dev, main, master or staging), or a deletion whose branch cannot be determined.');
  let request = original;
  for (let attempt = 0; ; attempt += 1) {
    const { findings, failure } = await evaluate(identity, groups, request);
    if (failure) {
      audit(identity, request, "failed", findings);
      return announced(identity, `Guardian could not check this ${what(request)}, so it was blocked. ${failure}`);
    }
    const outcome = worstOutcome(findings.map((finding) => finding.outcome));
    const acting = findings.filter((finding) => finding.outcome === outcome);
    if (outcome === "continue") return request === original ? { action: "continue" } : replaced(request);
    if (outcome === "block") {
      audit(identity, request, "blocked", acting);
      return announced(identity, `Guardian blocked this ${what(request)}. Rule ${acting.map(describe).join("; ")}.`);
    }
    if (!team && outcome === "fix" && attempt < MAX_FIX_ATTEMPTS) {
      const fixed = await applyFixes(identity, request, acting);
      if (fixed) { audit(identity, request, "fixed", acting); request = fixed; continue; }
    }
    // "ask", or a fix that could not be made or did not satisfy the rules.
    const reviewed = acting.length ? acting : findings;
    // Relay and team approvals remain one-time. A changed rule or working directory needs fresh consent.
    const alwaysKey = !team && !reviewed.some(finding => finding.group.relay)
      ? createHash('sha256').update(JSON.stringify([identity.projectId, identity.conversationId, identity.harness, identity.cwd, request, groups])).digest('hex') : undefined;
    if (alwaysKey && guardianActionAllowed(alwaysKey)) return request === original ? { action: "continue" } : replaced(request);
    const asked = Date.now();
    const decision = await requestGuardianReview({
      alwaysKey,
      projectId: identity.projectId, conversationId: identity.conversationId, title: reviewTitle(identity, request), subject: reviewSubject(request),
      operationKey: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
      detail: reviewed.map((finding) => `${finding.rule.name} rule · ${percent(finding.probability)} sure · ${finding.model}${finding.group.relay ? ` · ${finding.group.source}` : ""}`).join("\n"),
    }, identity.signal);
    // Nobody answering blocks too, so the audit says whether this was the person or the timeout.
    const waitedMs = Date.now() - asked;
    audit(identity, request, decision === "block" ? "denied" : decision === "allow-always" ? "allowed-always" : "allowed", reviewed, { waitedSeconds: Math.round(waitedMs / 1000), timedOut: decision === "block" && waitedMs >= REVIEW_TIMEOUT_MS });
    if (decision === "block") return { action: "block", reason: `The user blocked this ${what(request)} after Guardian flagged it. Rule ${reviewed.map(describe).join("; ")}.` };
    return request === original ? { action: "continue" } : replaced(request);
  }
}

function announced(identity: GuardianIdentity, reason: string): GuardianVerdict {
  announceGuardianBlock(identity.projectId, identity.conversationId, reason);
  return { action: "block", reason };
}

function replaced(request: GuardianRequest): GuardianVerdict {
  return request.kind === "tool" ? { action: "replace", input: request.input } : { action: "replace", text: request.text };
}

/**
 * A relay rule an agent cannot enforce stops the agent before it starts, so a machine never looks
 * protected when it is not. Claude and Kiro read tool output before anything can check it.
 */
export async function guardianStartProblem(harness: HarnessId, projectId?: string, conversationId?: string): Promise<string | null> {
  if (projectId && conversationId && guardianBypassed(projectId, conversationId)) return null;
  if (harness === "pi") return null;
  for (const group of await guardianGroups(projectId)) {
    if (!group.relay) continue;
    const rule = group.rules.find((item) => item.enabled && (item.check === "outgoing" || item.check === "all"));
    if (rule) return `${group.source} requires the Guardian rule "${rule.name}", which checks what is sent to the AI. ${getHarness(harness).label} reads tool output before Guardian can check it, so it cannot run here. Use Pi for this conversation.`;
  }
  return null;
}
