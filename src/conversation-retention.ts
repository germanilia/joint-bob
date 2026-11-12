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
  /** Files and rows that deletes made before the complete delete existed left on this machine. */
  leftovers: boolean;
  /** Joint Bob's own background runs, seven days after their last activity. */
  backgroundRuns: boolean;
}

export const CONVERSATION_RETENTION_SCOPE_KEYS = ["full", "includeUnrecorded", "includeScheduled", "leftovers", "backgroundRuns"] as const satisfies ReadonlyArray<keyof ConversationRetentionScope>;

export function defaultConversationRetentionScope(): ConversationRetentionScope {
  return { full: false, includeUnrecorded: false, includeScheduled: false, leftovers: false, backgroundRuns: false };
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
  // Sub-agent transcripts are read-only; schedules own their conversations.
  if (session.readOnly || session.cronTaskId) return undefined;
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

/**
 * Where the retention sweep writes a conversation before it deletes it, and how long that copy is
 * kept. A machine setting, off until the owner turns it on. With it on, the sweep deletes nothing it
 * could not back up first; a conversation a person deletes by hand is not backed up.
 */
export interface ConversationBackupSettings {
  destination: "off" | "folder" | "s3";
  /** Days a backup is kept before it is deleted as well. 0: kept until somebody removes it. */
  keepDays: number;
  /** The folder on this machine. Empty: `conversation-backups` in Joint Bob's data folder. */
  folder: string;
  s3: {
    bucket: string;
    region: string;
    /** Put in front of every object's name. */
    prefix: string;
    /** The address of an S3-compatible service. Empty for Amazon S3. */
    endpoint: string;
    /** "keys": the access key saved with this setting. "profile": an AWS profile on this machine, read through the AWS command line tool. */
    credentials: "keys" | "profile";
    accessKeyId: string;
    /** Empty: the machine's default profile. */
    profile: string;
  };
}

/**
 * What a save may carry: any part of the setting, and the secret key, which is never read back.
 * The two fields a GET adds may come back with a save; they are read-only and ignored.
 */
export type ConversationBackupInput = Partial<Omit<ConversationBackupSettings, "s3">> & { s3?: Partial<ConversationBackupSettings["s3"]> & { secretAccessKey?: string }; hasSecretAccessKey?: boolean; defaultFolder?: string };

export const DEFAULT_CONVERSATION_BACKUP_KEEP_DAYS = 30;

export function defaultConversationBackup(): ConversationBackupSettings {
  return { destination: "off", keepDays: DEFAULT_CONVERSATION_BACKUP_KEEP_DAYS, folder: "", s3: { bucket: "", region: "", prefix: "", endpoint: "", credentials: "keys", accessKeyId: "", profile: "" } };
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9][a-z0-9-]{1,30}$/;
const PROFILE = /^[A-Za-z0-9_][A-Za-z0-9_.@+=,-]{0,63}$/;
const ACCESS_KEY = /^[A-Za-z0-9]{8,128}$/;

const text = (given: unknown, fallback: string): string => (typeof given === "string" ? given.trim() : fallback);

/** A stored value read back: whatever is missing or of the wrong kind takes its default. */
export function storedConversationBackup(saved: unknown): ConversationBackupSettings {
  const backup = defaultConversationBackup();
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return backup;
  const given = saved as Record<string, unknown>, s3 = (given.s3 && typeof given.s3 === "object" ? given.s3 : {}) as Record<string, unknown>;
  if (given.destination === "folder" || given.destination === "s3") backup.destination = given.destination;
  if (Number.isInteger(given.keepDays) && (given.keepDays as number) >= 0) backup.keepDays = given.keepDays as number;
  backup.folder = text(given.folder, "");
  for (const key of ["bucket", "region", "prefix", "endpoint", "accessKeyId", "profile"] as const) backup.s3[key] = text(s3[key], "");
  if (s3.credentials === "profile") backup.s3.credentials = "profile";
  return backup;
}

/** A backup setting a person typed that cannot be saved. Its message is for that person. */
export class ConversationBackupSettingError extends Error {}

/**
 * The setting after a save: `previous` with the given parts over it, checked. A destination can
 * only be chosen with everything it needs, so a sweep never finds half a setting. `hasSecret` says
 * whether a secret key is saved or comes with this save. `absolute` tells an absolute path.
 */
export function mergedConversationBackup(previous: ConversationBackupSettings, input: ConversationBackupInput, hasSecret: boolean, absolute: (folder: string) => boolean): ConversationBackupSettings {
  const { secretAccessKey: _secret, ...s3 } = input.s3 ?? {};
  const next = storedConversationBackup({ ...previous, ...input, s3: { ...previous.s3, ...s3 } });
  if (input.destination !== undefined && !["off", "folder", "s3"].includes(input.destination)) throw new ConversationBackupSettingError("Conversation backups go to a folder, to S3, or nowhere");
  if (input.keepDays !== undefined && (!Number.isInteger(input.keepDays) || input.keepDays < 0 || input.keepDays > 3650)) throw new ConversationBackupSettingError("Backups are kept for 0 to 3650 days; 0 keeps them for good");
  if (input.s3?.credentials !== undefined && !["keys", "profile"].includes(input.s3.credentials)) throw new ConversationBackupSettingError("S3 credentials are an access key or a profile");
  if (next.folder && !absolute(next.folder)) throw new ConversationBackupSettingError("The backup folder must be an absolute path");
  next.s3.prefix = next.s3.prefix.replace(/^\/+|\/+$/g, "");
  if (next.s3.prefix.length > 200 || /[\u0000-\u001f\u007f\\]/.test(next.s3.prefix) || next.s3.prefix.split("/").some((part) => part === "." || part === "..")) throw new ConversationBackupSettingError("The S3 prefix is not a usable folder name");
  if (next.s3.endpoint) {
    let address: URL | undefined;
    try { address = new URL(next.s3.endpoint); } catch { /* reported below */ }
    if (!address || !["http:", "https:"].includes(address.protocol) || address.search || address.hash || address.username) throw new ConversationBackupSettingError("The S3 endpoint must be an http or https address");
    next.s3.endpoint = next.s3.endpoint.replace(/\/+$/, "");
  }
  if (next.s3.bucket && !BUCKET.test(next.s3.bucket)) throw new ConversationBackupSettingError("That is not a bucket name S3 accepts");
  if (next.s3.region && !REGION.test(next.s3.region)) throw new ConversationBackupSettingError("That is not an AWS region, such as eu-west-1");
  if (next.s3.profile && !PROFILE.test(next.s3.profile)) throw new ConversationBackupSettingError("That is not a usable AWS profile name");
  if (next.s3.accessKeyId && !ACCESS_KEY.test(next.s3.accessKeyId)) throw new ConversationBackupSettingError("That is not an access key ID");
  if (next.destination === "s3") {
    if (!next.s3.bucket) throw new ConversationBackupSettingError("Backups to S3 need a bucket");
    if (!next.s3.region) throw new ConversationBackupSettingError("Backups to S3 need the bucket's region");
    if (next.s3.credentials === "keys" && (!next.s3.accessKeyId || !hasSecret)) throw new ConversationBackupSettingError("Backups to S3 need an access key ID and its secret key, or a profile");
  }
  return next;
}
