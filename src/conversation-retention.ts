import type { SessionSummary } from "./types.js";

export const DEFAULT_CONVERSATION_RETENTION_DAYS = 40;
/** A just-opened conversation is a draft until its first message; give it time to get one. */
export const EMPTY_CONVERSATION_GRACE_MS = 60 * 60_000;
/** A draft nobody owns may be a new conversation whose owner has not replicated its claim yet. */
export const UNOWNED_EMPTY_CONVERSATION_GRACE_MS = 7 * 24 * 60 * 60_000;

export type RetentionReason = "empty" | "expired";

/**
 * What the owner lets the retention sweep delete beyond the conversations a project's list still
 * shows, and what it may clear up. A machine setting; every box is off until the owner ticks it.
 */
export interface ConversationRetentionScope {
  /** Every conversation on record in a project, not only the ones its list shows. */
  full: boolean;
  /** With `full`: transcripts that have no record, when they lie in a current project's folders. */
  includeUnrecorded: boolean;
  /** With `full`: the conversations that scheduled tasks and webhooks made, one per run. */
  includeScheduled: boolean;
  /** With `full`: the conversations of finished tickets. An unfinished ticket keeps its conversation. */
  includeTickets: boolean;
  /** Files and rows that deletes made before the complete delete existed left on this machine. */
  leftovers: boolean;
  /** Joint Bob's own background runs, seven days after their last activity. */
  backgroundRuns: boolean;
}

export const CONVERSATION_RETENTION_SCOPE_KEYS = ["full", "includeUnrecorded", "includeScheduled", "includeTickets", "leftovers", "backgroundRuns"] as const satisfies ReadonlyArray<keyof ConversationRetentionScope>;

export function defaultConversationRetentionScope(): ConversationRetentionScope {
  return { full: false, includeUnrecorded: false, includeScheduled: false, includeTickets: false, leftovers: false, backgroundRuns: false };
}

export interface RetentionContext {
  now: number;
  retentionDays: number;
  /** `engine:sessionId` keys and session paths pinned by any user. */
  pinned: Set<string>;
  /** Whether this node, and no other, may delete the conversation; `undefined` when nobody owns it yet. */
  ownedLocally: (session: SessionSummary) => boolean | undefined;
  hasQueuedPrompts: (session: SessionSummary) => boolean;
}

function segmentKeys(session: SessionSummary): string[] {
  return [
    `${session.harnessId}:${session.id}`, session.path,
    ...(session.conversationId ? [`${session.segments?.[0]?.engine ?? session.harnessId}:${session.conversationId}`] : []),
    ...(session.segments ?? []).flatMap((segment) => [`${segment.engine}:${segment.sessionId}`, segment.path]),
  ];
}

/** Why a listed conversation should be deleted now, or `undefined` to keep it. */
export function retentionReason(session: SessionSummary, context: RetentionContext): RetentionReason | undefined {
  // Sub-agent transcripts and done tickets are read-only; tickets and schedules own their conversations.
  if (session.readOnly || session.taskId || session.cronTaskId) return undefined;
  if (segmentKeys(session).some((key) => context.pinned.has(key))) return undefined;
  const owned = context.ownedLocally(session);
  if (owned === false) return undefined;
  const updatedAt = Date.parse(session.updatedAt ?? session.createdAt ?? "");
  if (!Number.isFinite(updatedAt)) return undefined;
  const age = context.now - updatedAt;
  const empty = session.draft && (session.segments ?? []).every((segment) => segment.draft);
  if (empty) {
    if (context.hasQueuedPrompts(session)) return undefined;
    return age >= (owned ? EMPTY_CONVERSATION_GRACE_MS : UNOWNED_EMPTY_CONVERSATION_GRACE_MS) ? "empty" : undefined;
  }
  return age >= context.retentionDays * 86_400_000 ? "expired" : undefined;
}
