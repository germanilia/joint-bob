import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getClusterNode } from "./cluster.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { ConversationRecord } from "./conversation-records.js";
import { parseJsonlSkippingDamage } from "./jsonl.js";
import type { ProjectRecord, SessionSummary } from "./types.js";
import { normalizeUsageRecords } from "./usage-import.js";
import { saveUsageEvents, saveUsageIngestFingerprint, upsertUsageInventory, usageIngestFingerprint } from "./usage-ledger.js";

/**
 * A transcript being written changes on every turn, and importing it re-reads the whole file,
 * so a changed file is re-imported at most once per interval.
 */
export const USAGE_REIMPORT_INTERVAL_MS = 60_000;
const fingerprints = new Map<string, { fingerprint: string; status: string; importedAt?: number }>();
const inFlight = new Map<string, Promise<string>>();
let forcedRefreshes = 0;

function nativePath(session: SessionSummary): string | null {
  if (session.draft || !["pi", "claude"].includes(session.harnessId)) return null;
  return path.resolve(session.path.replace(/^(pi|claude):/, ""));
}

/** Where the first session with each path and each file name is listed, so a side run finds its parent without comparing every session's name again. */
function parentIndex(sessions: SessionSummary[]): Map<string, number> {
  const index = new Map<string, number>();
  sessions.forEach((candidate, position) => {
    for (const key of [`path\n${candidate.path}`, `name\n${path.basename(candidate.path)}`]) if (!index.has(key)) index.set(key, position);
  });
  return index;
}
function parentFor(session: SessionSummary, sessions: SessionSummary[], index: Map<string, number>): SessionSummary | undefined {
  if (!session.readOnly || !session.parentSessionPath) return undefined;
  // The earliest match in the listing, as a scan from its start would find.
  const found = [index.get(`path\n${session.parentSessionPath}`), index.get(`name\n${path.basename(session.parentSessionPath)}`)].filter((position): position is number => position !== undefined);
  return found.length ? sessions[Math.min(...found)] : undefined;
}

async function importSession(project: ProjectRecord, session: SessionSummary, conversationId: string, origin: string): Promise<string> {
  const file = nativePath(session);
  if (!file) return session.draft ? "empty" : "unavailable";
  const key = `${project.id}:${conversationId}:${session.harnessId}:${session.id}:${file}`;
  const running = inFlight.get(key);
  if (running) return running;
  const pending = (async () => {
    let info;
    try { info = await stat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
    // Schema revision forces one bounded reparse of old transcripts for provable read evidence.
    // Claude's went up again: skills it loads through its Skill tool were not counted before.
    const revision = session.harnessId === "claude" ? "skills-v2" : "skills-v1";
    const fingerprint = `${revision}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${project.id}:${conversationId}`;
    // The persisted fingerprint keeps a restart from re-reading every transcript on disk.
    const cached: { fingerprint: string; status: string; importedAt?: number } | undefined = fingerprints.get(key) ?? usageIngestFingerprint(key);
    if (cached) fingerprints.set(key, cached);
    if (cached?.fingerprint === fingerprint) return cached.status;
    if (!forcedRefreshes && cached?.importedAt && Date.now() - cached.importedAt < USAGE_REIMPORT_INTERVAL_MS) return cached.status;
    let contents: string;
    try { contents = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
    const records = parseJsonlSkippingDamage(contents, file);
    const { usageModelPricing } = await import("./pi-service.js");
    const events = normalizeUsageRecords(session.harnessId, session.id, records, {
      projectId: project.id, conversationId, createdAt: session.createdAt || project.createdAt,
    }, (provider, modelId) => {
      const pricing = usageModelPricing(provider, modelId);
      return pricing?.rates ? { rates: pricing.rates, pricing } : null;
    });
    saveUsageEvents(events, origin);
    const status = events.some((event) => event.usageStatus === "missing") ? "missing" : "reported";
    fingerprints.set(key, { fingerprint, status, importedAt: Date.now() });
    saveUsageIngestFingerprint(key, fingerprint, status);
    return status;
  })();
  inFlight.set(key, pending);
  try { return await pending; }
  finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
}

export async function ingestUsageSessions(project: ProjectRecord, sessions: SessionSummary[], records: ConversationRecord[], concurrency = 4): Promise<void> {
  const lineage = new Map(records.map((record) => [`${record.engine}:${record.sessionId}`, record.conversationId ?? record.sessionId]));
  const origin = (await getClusterNode()).id;
  const ordered = [...sessions].sort((a, b) => (a.createdAt ?? project.createdAt).localeCompare(b.createdAt ?? project.createdAt));
  const parents = parentIndex(sessions);
  await mapWithConcurrency(ordered, concurrency, async (session) => {
    const parent = parentFor(session, sessions, parents);
    const conversationId = parent
      ? lineage.get(`${parent.harnessId}:${parent.id}`) ?? parent.conversationId ?? parent.id
      : lineage.get(`${session.harnessId}:${session.id}`) ?? session.conversationId ?? session.id;
    const status = await importSession(project, session, conversationId, origin);
    upsertUsageInventory({
      projectId: project.id, conversationId, sessionId: session.id, engine: session.harnessId,
      title: parent?.title ?? session.title, classification: parent?.classification ?? session.classification ?? null, usageStatus: status,
    }, forcedRefreshes > 0);
    await new Promise((resolve) => setImmediate(resolve));
  });
}

/**
 * Listings schedule imports instead of awaiting them. Importing a whole history inside the
 * listing request held that request, and a node's startup, for minutes: a peer's inventory
 * request is a listing too. One import runs at a time, a file at a time, with the latest
 * listing of each project.
 */
type IngestJob = { project: ProjectRecord; sessions: SessionSummary[]; records: ConversationRecord[] };
const scheduled = new Map<string, IngestJob>();
let draining: Promise<void> | undefined;

/**
 * Every list and board pass lists every project, and each pass re-walked all of a project's
 * transcripts (27 projects about 32 times a minute each on 2026-11-23). A changed transcript is
 * re-read at most once per USAGE_REIMPORT_INTERVAL_MS anyway, so an unchanged listing waits this
 * long after its last import. New, renamed, or re-linked sessions still import at once.
 */
export const USAGE_RESCHEDULE_MS = 30_000;
const lastJobs = new Map<string, IngestJob & { finishedAt?: number }>();
const SESSION_FIELDS = ["id", "path", "harnessId", "draft", "readOnly", "parentSessionPath", "title", "classification", "conversationId", "createdAt"] as const;
function sameJob(previous: IngestJob, next: IngestJob): boolean {
  return previous.project.createdAt === next.project.createdAt
    && previous.sessions.length === next.sessions.length
    && previous.sessions.every((session, index) => session === next.sessions[index] || SESSION_FIELDS.every((field) => session[field] === next.sessions[index][field]))
    && previous.records.length === next.records.length
    && previous.records.every((record, index) => {
      const other = next.records[index];
      return record === other || (record.engine === other.engine && record.sessionId === other.sessionId && record.conversationId === other.conversationId && record.segmentIndex === other.segmentIndex);
    });
}

export function scheduleUsageIngest(project: ProjectRecord, sessions: SessionSummary[], records: ConversationRecord[]): void {
  const job = { project, sessions, records };
  const last = lastJobs.get(project.id);
  // A queued or recent import of the same listing covers this one; a forced refresh never waits.
  if (!forcedRefreshes && last && (last.finishedAt === undefined || Date.now() - last.finishedAt < USAGE_RESCHEDULE_MS) && sameJob(last, job)) return;
  lastJobs.set(project.id, job);
  scheduled.set(project.id, job);
  if (!draining) startDrain();
}

function startDrain(): void {
  draining = (async () => {
    for (const [id, job] of scheduled) {
      scheduled.delete(id);
      try { await ingestUsageSessions(job.project, job.sessions, job.records, 1); }
      catch (error) { console.warn(`Usage import for project ${id} failed`, error); }
      finally {
        const last = lastJobs.get(id);
        if (last === job) last.finishedAt = Date.now();
      }
    }
  })().finally(() => { draining = undefined; if (scheduled.size) startDrain(); });
}

/** Resolves once every scheduled import has finished, for callers that report totals. */
export async function usageIngestIdle(): Promise<void> {
  while (draining) await draining;
}

/**
 * Runs work that schedules imports, bypasses the live-transcript debounce, and waits for them,
 * so budget checks and requested refreshes read current spend while keeping fingerprint dedup.
 */
export async function withFreshUsage<T>(work: () => Promise<T>): Promise<T> {
  forcedRefreshes++;
  try { const value = await work(); await usageIngestIdle(); return value; }
  finally { forcedRefreshes--; }
}
