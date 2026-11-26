import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { asNode } from "../account-context.js";
import { getClusterNode } from "../cluster.js";
import { closeoutAssessment, inactiveConversation, type CloseoutFeedback, type CloseoutRecord, type LearnedRule } from "../conversation-closeout.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { listConversationSegments } from "../conversation-records.js";
import { listHarnessSessions } from "../harnesses.js";
import { sessionDoneOverrides, sessionFeedbackOverrides, sessionFeedbackWriters, setSessionDone, setSessionFeedback } from "../names.js";
import { generalShelf } from "../general-knowledge.js";
import { addRuleIn, normalizedRuleText, projectShelf, readSubjectsIn, removedRules } from "../project-knowledge.js";
import { withProjectRuntime } from "../project-runtime.js";
import { listProjects } from "../store.js";
import type { ProjectRecord } from "../types.js";
import { CloseoutUnavailableError, closeoutModels } from "./closeout-models.js";
import { loadConversationMessages } from "./conversation-turns.js";
import { harnessSessions, harnessSessionBusy } from "./harness-sessions.js";
import { broadcastToProject } from "./realtime.js";
import { projectAdditionalPaths } from "./session-scope.js";
import { flags } from "./state.js";
import { cleanupDoneWorktrees } from "./worktree-cleanup.js";

export interface CloseoutRuntime {
  load: typeof loadConversationMessages;
  models: typeof closeoutModels;
  sourceRoot: () => Promise<string | null>;
}
const realRuntime: CloseoutRuntime = { load: loadConversationMessages, models: closeoutModels, sourceRoot: async () => (await jointBobSourceProject())?.path ?? null };
const running = new Map<string, Promise<string | undefined>>();
/** Reviews run one at a time on a machine, so closing many conversations at once (Organize, Select) queues them instead of starting them all together. */
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}
function busy(projectId: string, id: string): boolean {
  return [...harnessSessions.values()].some((shared) => shared.projectId === projectId && shared.conversationId === id && harnessSessionBusy(shared));
}

/** Persist before inference so an interrupted closeout is picked up after restart. */
export async function beginConversationCloseout(project: ProjectRecord, engine: string, id: string, feedback: CloseoutFeedback | null): Promise<CloseoutRecord> {
  const record: CloseoutRecord = { revision: randomUUID(), projectId: project.id, engine, source: feedback ? "manual" : "automatic", feedback, status: "pending" };
  await setSessionFeedback(id, record);
  await setSessionDone(id, true);
  return record;
}

/** The Joint Bob source checkout among this machine's projects, where general lessons are written so they ship; null when it holds none. */
export async function jointBobSourceProject(): Promise<ProjectRecord | null> {
  for (const project of await listProjects()) {
    const manifest = path.join(project.path, "package.json");
    if (!existsSync(path.join(project.path, ".git")) || !existsSync(manifest)) continue;
    if ((JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === "joint-bob") return project;
  }
  return null;
}

/**
 * Installs the lessons the decision model kept, without waiting for a person: project lessons in the project's
 * knowledge, general ones in Joint Bob's source. On a machine without that source a general lesson stays
 * with the project, and its evidence says so. A rule already known in its place, or one a person removed there, is not written again.
 */
async function learnLessons(project: ProjectRecord, id: string, rules: LearnedRule[], sourceRoot: () => Promise<string | null>): Promise<void> {
  const source = rules.some((rule) => rule.scope === "general") ? await sourceRoot() : null;
  for (const rule of rules) {
    const general = rule.scope === "general" && source !== null;
    const shelf = general ? generalShelf(source) : projectShelf(project.path);
    const text = normalizedRuleText(rule.text);
    if (removedRules(shelf.directory).includes(text)) continue;
    if (readSubjectsIn(shelf.directory).some((subject) => subject.rules.some((known) => normalizedRuleText(known.text) === text))) continue;
    const kept = rule.scope === "general" && !general ? "; a general lesson, kept here because this machine has no Joint Bob source" : "";
    addRuleIn(shelf, { subject: rule.subject, text: rule.text, evidence: `${rule.evidence} (conversation ${id}${kept})` });
  }
}

/**
 * When the hourly sweep may try a failed closeout again. Each sweep used to retry every failed
 * one (about 500 on the homeserver), rewriting and replicating its record and logging each
 * time. A failure now waits an hour, doubling up to a week; one that needs a Settings change
 * (no decision model or key) waits a day at a time. A new rating or reopen is a new revision
 * and starts afresh, and a closeout asked for by hand always runs.
 */
const RETRY_FIRST_MS = 3_600_000;
const RETRY_LONGEST_MS = 7 * 86_400_000;
const RETRY_UNAVAILABLE_MS = 86_400_000;
const retries = new Map<string, { revision: string; failures: number; nextAt: number; message: string }>();
function noteFailure(id: string, record: CloseoutRecord, error: unknown, message: string): { first: boolean } {
  const kept = retries.get(id);
  const failures = kept?.revision === record.revision ? kept.failures + 1 : 1;
  const wait = error instanceof CloseoutUnavailableError ? RETRY_UNAVAILABLE_MS : Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_LONGEST_MS);
  retries.set(id, { revision: record.revision, failures, nextAt: Date.now() + wait, message });
  return { first: kept?.revision !== record.revision || kept.message !== message };
}
function retryDue(id: string, record: CloseoutRecord, now: number): boolean {
  const kept = retries.get(id);
  if (!kept || kept.revision !== record.revision) {
    // A failure stored before this process started waits one interval like a fresh one, so a
    // restart does not retry every failed closeout at once.
    retries.set(id, { revision: record.revision, failures: 1, nextAt: now + RETRY_FIRST_MS, message: record.error ?? "" });
    return false;
  }
  return kept.nextAt <= now;
}

/** Clears what the sweep remembers about failures (tests start from a fresh process this way). */
export function forgetCloseoutRetries(): void { retries.clear(); }

/** Never let an older inference overwrite a new rating or a reopen. Errors remain visible and retryable. */
export function finishConversationCloseout(project: ProjectRecord, id: string, record: CloseoutRecord, runtime: CloseoutRuntime = realRuntime): Promise<string | undefined> {
  const previous = running.get(id);
  if (previous) return previous.then(() => finishConversationCloseout(project, id, record, runtime));
  if (record.status === "complete") return Promise.resolve(undefined);
  const job = oneAtATime(() => processCloseout(project, id, record, runtime)).finally(() => running.delete(id));
  running.set(id, job);
  return job;
}

async function processCloseout(project: ProjectRecord, id: string, record: CloseoutRecord, runtime: CloseoutRuntime): Promise<string | undefined> {
  // A review that finished while this one waited in the queue is not run again.
  const current = async () => {
    const stored = (await sessionFeedbackOverrides())[id];
    return stored?.revision === record.revision && stored.status !== "complete" && Boolean((await sessionDoneOverrides())[id]);
  };
  let changed = true;
  try {
    if (!await current()) return;
    const transcript = await runtime.load(project, id);
    if (record.source === "automatic" && !inactiveConversation(transcript.messages, busy(project.id, id), false, Date.now())) {
      if (await current()) { await setSessionFeedback(id, null); await setSessionDone(id, false); }
      return;
    }
    const result = await closeoutAssessment(record.feedback, runtime.models(project, id, transcript));
    if (!await current()) return;
    if (record.source === "automatic") {
      const latest = await runtime.load(project, id);
      if (!inactiveConversation(latest.messages, busy(project.id, id), false, Date.now())) {
        await setSessionFeedback(id, null);
        await setSessionDone(id, false);
        return;
      }
    }
    if (result.rules.length) await learnLessons(project, id, result.rules, runtime.sourceRoot);
    await setSessionFeedback(id, { ...record, feedback: { rating: result.rating, description: result.description }, status: "complete", error: undefined });
    retries.delete(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Conversation feedback failed";
    // The same error on the same revision is already stored and shown: writing it again only replicated it.
    changed = record.status !== "error" || record.error !== message;
    if (changed && await current()) await setSessionFeedback(id, { ...record, status: "error", error: message });
    if (noteFailure(id, record, error, message).first) console.warn(`Conversation feedback failed for ${id}: ${message}`);
    return message;
  } finally {
    if (changed) broadcastToProject(project.id, { type: "sessionsChanged" });
  }
}

async function localOwner(projectId: string, engine: string, id: string, nodeId: string): Promise<boolean> {
  const segments = await listConversationSegments(projectId, id);
  const latest = segments.at(-1);
  const owner = await getConversationOwnership(latest?.engine ?? engine, latest?.sessionId ?? id);
  return owner?.ownerNodeId === nodeId && owner.status === "owned";
}

/**
 * A closeout a restart interrupted runs again, a failed one when its retry is due. Only the machine that last
 * wrote the record does it (the one that was asked, or the one whose attempt failed), so no review runs twice.
 */
async function retryProjectCloseouts(project: ProjectRecord, nodeId: string, now: number): Promise<void> {
  const feedback = await sessionFeedbackOverrides();
  const writers = await sessionFeedbackWriters();
  for (const [id, record] of Object.entries(feedback)) {
    if (record.projectId !== project.id || record.status === "complete" || busy(project.id, id)) continue;
    if (writers[id] !== nodeId) continue;
    if (record.status === "error" && !retryDue(id, record, now)) continue;
    await finishConversationCloseout(project, id, record);
  }
}

/** Keep failed/pending worktree transcripts available for another attempt. */
async function cleanupWhenLearned(project: ProjectRecord): Promise<void> {
  const pending = Object.values(await sessionFeedbackOverrides()).some((record) => record.projectId === project.id && record.status !== "complete");
  if (!pending) await cleanupDoneWorktrees(project);
}

/** Owner-only sweep: activity comes from the transcript, never file mtime or metadata replication. */
async function closeInactiveProject(project: ProjectRecord, nodeId: string, now: number): Promise<void> {
  await retryProjectCloseouts(project, nodeId, now);
  const done = await sessionDoneOverrides();
  const sessions = await listHarnessSessions({ ...project, additionalPaths: await projectAdditionalPaths(project.id) });
  for (const session of sessions) {
    const id = session.conversationId ?? session.id;
    if (done[id] || busy(project.id, id) || !await localOwner(project.id, session.harnessId, id, nodeId)) continue;
    const transcript = await loadConversationMessages(project, id);
    if (!inactiveConversation(transcript.messages, busy(project.id, id), false, now)) continue;
    // A rating or reopen during transcript loading takes precedence over the sweep.
    if ((await sessionDoneOverrides())[id] || (await sessionFeedbackOverrides())[id]?.source === "manual") continue;
    const record = await beginConversationCloseout(project, session.harnessId, id, null);
    await finishConversationCloseout(project, id, record);
  }
  await cleanupWhenLearned(project);
}

/** The hourly sweep: finishes this machine's interrupted and failed closeouts. It does not close conversations by itself. */
export async function retryUnfinishedCloseouts(now = Date.now()): Promise<void> {
  await asNode(async () => {
    const node = await getClusterNode();
    for (const project of await listProjects()) {
      try { await withProjectRuntime(project.id, async () => { await retryProjectCloseouts(project, node.id, now); await cleanupWhenLearned(project); }); }
      catch (error) { console.warn(`Conversation closeout retry failed for ${project.id}`, error); }
    }
  });
}

export async function runInactiveConversationCloseout(now = Date.now()): Promise<void> {
  await asNode(async () => {
    const node = await getClusterNode();
    for (const project of await listProjects()) {
      try { await withProjectRuntime(project.id, () => closeInactiveProject(project, node.id, now)); }
      catch (error) { console.warn(`Inactive conversation closeout failed for ${project.id}`, error); }
    }
  });
}

let started = false;
export function startConversationCloseoutScheduler(): void {
  // Test nodes have no decision model: retrying their closeouts would only log the same failure. A test about the sweep opts in.
  if (process.env.NODE_ENV === "test" && process.env.JOINT_BOB_TEST_CLOSEOUT_SWEEP !== "1") return;
  if (started) return;
  started = true;
  const schedule = (delay: number): void => {
    setTimeout(() => {
      void (async () => { if (flags.startupReady) await retryUnfinishedCloseouts(); })()
        .catch((error) => console.warn("Conversation closeout retry failed", error))
        .finally(() => schedule(3_600_000));
    }, delay).unref();
  };
  schedule(60_000);
}
