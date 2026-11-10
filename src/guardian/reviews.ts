import { createHash, randomUUID } from "node:crypto";
import { teamAssistantForConversation } from '../assistant-resources.js';
import type { TeamMember } from '../assistant-teams/access.js';

/** A review nobody answers blocks the action: scheduled runs and webhooks never wait forever. */
export const REVIEW_TIMEOUT_MS = 10 * 60_000;
const SUBJECT_LIMIT = 4_000;

export interface GuardianReview {
  id: string;
  projectId: string;
  conversationId: string;
  /** "Pi wants to run a command that could delete data". */
  title: string;
  /** The command, file change or content, shortened for the card. */
  subject: string;
  /** "Dangerous commands rule · 94% sure · Jev". */
  detail: string;
  createdAt: string;
  expiresAt: string;
  operationKey?: string;
  team?: { teamId: string; assignmentId: string; requestId: string; requestedBy: string; operationKey: string };
}

export type ReviewDecision = "allow" | "block";

/** What the chat server pushes to a conversation's viewers: its open reviews changed, or Guardian blocked something on its own. */
export type GuardianEvent =
  | { type: "reviews"; projectId: string; conversationId: string; review: GuardianReview }
  | { type: "blocked"; projectId: string; conversationId: string; message: string };

const pending = new Map<string, { review: GuardianReview; settle: (decision: ReviewDecision) => void }>();
const listeners = new Set<(event: GuardianEvent) => void>();

export function onGuardianEvent(listener: (event: GuardianEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: GuardianEvent): void {
  for (const listener of listeners) listener(event);
}

function changed(review: GuardianReview): void {
  if (review.team) void import('../assistant-teams/store.js').then(({ announceTeamChange }) => announceTeamChange(review.team!.teamId));
  emit({ type: "reviews", projectId: review.projectId, conversationId: review.conversationId, review });
}

/** A block nobody was asked about still shows in the conversation, so the person knows why the agent stopped. */
export function announceGuardianBlock(projectId: string, conversationId: string, message: string): void {
  emit({ type: "blocked", projectId, conversationId, message });
}

/** Waits for the person's decision on one action. Resolves "block" after the timeout or when the run is stopped. */
export function requestGuardianReview(input: Omit<GuardianReview, "id" | "createdAt" | "expiresAt" | "team">, signal?: AbortSignal, timeoutMs = REVIEW_TIMEOUT_MS): Promise<ReviewDecision> {
  const now = Date.now();
  const review: GuardianReview = {
    ...input, subject: input.subject.length > SUBJECT_LIMIT ? `${input.subject.slice(0, SUBJECT_LIMIT)}\n…` : input.subject,
    id: randomUUID(), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + timeoutMs).toISOString(),
  };
  if (teamAssistantForConversation(input.projectId, input.conversationId)) {
    const operationKey = input.operationKey ?? createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return import('../assistant-teams/assignments.js').then(async ({ bindTeamGuardianReview, assignmentDatabase }) => {
      review.team = await bindTeamGuardianReview(input.projectId, input.conversationId, operationKey);
      const db = await assignmentDatabase();
      db.prepare('INSERT INTO assistant_team_approvals VALUES(?,?,?,?)').run(review.id, review.team.assignmentId, 'pending', JSON.stringify(review));
      return openReview(review, signal, timeoutMs, decision => {
        db.prepare("UPDATE assistant_team_approvals SET state=? WHERE review_id=? AND state='pending'").run(decision === 'allow' ? 'allowed' : 'blocked', review.id);
      });
    }).catch(() => 'block');
  }
  return openReview(review, signal, timeoutMs);
}
function openReview(review: GuardianReview, signal: AbortSignal | undefined, timeoutMs: number, settled?: (decision: ReviewDecision) => void): Promise<ReviewDecision> {
  return new Promise<ReviewDecision>((resolve) => {
    const settle = (decision: ReviewDecision) => {
      if (!pending.delete(review.id)) return;
      settled?.(decision);
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      changed(review);
      resolve(decision);
    };
    const stop = () => settle("block");
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    pending.set(review.id, { review, settle });
    changed(review);
    if (signal?.aborted) stop();
  });
}

/** The person's answer. Only the conversation the review belongs to can answer it. */
export function decideGuardianReview(projectId: string, conversationId: string, id: string, decision: ReviewDecision): boolean {
  const entry = pending.get(id);
  if (!entry || entry.review.team || entry.review.projectId !== projectId || entry.review.conversationId !== conversationId) return false;
  entry.settle(decision);
  return true;
}

/** Team approval never enters the owner endpoint or constructs an owner session. */
export async function decideTeamGuardianReview(member: TeamMember, assignmentId: string, id: string, decision: ReviewDecision): Promise<boolean> {
  const { recheckTeamActor, requireTeamExecution } = await import('../assistant-teams/access.js');
  await recheckTeamActor(member); await requireTeamExecution(member.teamId, member.accountId);
  const entry = pending.get(id), binding = entry?.review.team;
  if (!entry || !binding || binding.teamId !== member.teamId || binding.assignmentId !== assignmentId) return false;
  const { bindTeamGuardianReview, assignmentDatabase } = await import('../assistant-teams/assignments.js');
  const current = await bindTeamGuardianReview(entry.review.projectId, entry.review.conversationId, binding.operationKey);
  if (JSON.stringify(current) !== JSON.stringify(binding) || pending.get(id) !== entry) return false;
  const db = await assignmentDatabase();
  const record = { ...entry.review, approvedBy: member.accountId, decision, decidedAt: new Date().toISOString() };
  if (!db.prepare("UPDATE assistant_team_approvals SET state=?,record=? WHERE review_id=? AND state='pending'").run(decision === 'allow' ? 'allowed' : 'blocked', JSON.stringify(record), id).changes) return false;
  entry.settle(decision); return true;
}

/** Stopping a turn blocks whatever it was waiting on. */
export function cancelGuardianReviews(projectId: string, conversationId: string): void {
  for (const { review, settle } of [...pending.values()]) if (review.projectId === projectId && review.conversationId === conversationId) settle("block");
}

/** Every open review on this machine, for the control center. */
export function allPendingGuardianReviews(): GuardianReview[] {
  return [...pending.values()].map(({ review }) => review);
}

export function pendingGuardianReviews(projectId: string, conversationId: string): GuardianReview[] {
  return [...pending.values()].map(({ review }) => review).filter((review) => review.projectId === projectId && review.conversationId === conversationId);
}
