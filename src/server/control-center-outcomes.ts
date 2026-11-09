import type { DatabaseSync } from "node:sqlite";
import { runAsAccount, type ActingAccount } from "../account-context.js";
import { automationRunOf, webhookRunsSince } from "../automation-executions.js";
import { listBobAccounts, readBobSettings, type BobSettings } from "../control-center/bob-store.js";
import { answerDigest, judgeOutcome, knownOutcome, rememberOutcome, type JudgeDeps, type OutcomeAnswer } from "../control-center/triggers-outcome.js";
import { followedTriggers, followsCallsIn, matchTriggerRuns, noteTriggerOutcome, oldestUnmatchedTrigger, type Trigger } from "../control-center/triggers-store.js";
import { conversationsStartedBy } from "../conversation-starts.js";
import { getProject } from "../store.js";
import type { ProjectRecord, SessionSummary } from "../types.js";
import { bobSessionFor } from "./control-center-session.js";
import { triggerDatabase, triggerJudgeDeps } from "./control-center-triggers.js";
import { loadConversationMessages } from "./conversation-turns.js";
import { onConversationTurn } from "./harness-sessions.js";
import { broadcastToAllClients } from "./realtime.js";
import { sharedProjectSessions } from "./sessions-helpers.js";
import { flags } from "./state.js";

/**
 * Bob follows each call in the webhook log to the conversation its run started, and notes on the call how that ended:
 * settled (it fixed it, found an existing fix, or found nothing wrong), in hand (still working, or waiting for CI or its own
 * merge), or needs you (blocked on something only the person can do). The log shows it; nothing goes to Bob's chat.
 * A run that opened a worktree and started another conversation there is followed to that one: the start is recorded
 * (conversation-starts.ts), and for calls from before that, it is the conversation the run's last answer names.
 * The decision model judges the conversation's last answer, and Bob's agent when it is less sure than the threshold; one
 * answer is judged once. Calls are checked when a turn ends in their project, and once when the server starts.
 */

export interface OutcomeSources {
  project(projectId: string, actor: ActingAccount): Promise<ProjectRecord | undefined>;
  sessions(project: ProjectRecord, actor: ActingAccount): Promise<SessionSummary[]>;
  lastAnswer(project: ProjectRecord, conversationId: string): Promise<string>;
  deps(actor: ActingAccount, settings: BobSettings, project: ProjectRecord): Promise<JudgeDeps>;
}

const realSources: OutcomeSources = {
  project: (projectId, actor) => runAsAccount(actor, () => getProject(projectId)),
  async sessions(project, actor) {
    const session = bobSessionFor(actor.accountId, "outcomes");
    return session ? runAsAccount(actor, () => sharedProjectSessions(project, session.userId, session.accountId)) : [];
  },
  async lastAnswer(project, conversationId) {
    const { messages } = await loadConversationMessages(project, conversationId);
    return [...messages].reverse().find((message) => message.role === "assistant" && message.text.trim())?.text.trim() ?? "";
  },
  deps: (actor, settings, project) => triggerJudgeDeps(actor, settings, project),
};

const idOf = (session: SessionSummary): string => session.conversationId ?? session.id;
const newest = (sessions: SessionSummary[]): SessionSummary | undefined => [...sessions].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))[0];

/** The conversation that works on a call: the one its run started, or the run's own. */
async function investigationOf(db: DatabaseSync, project: ProjectRecord, sessions: SessionSummary[], runSessionId: string, sources: OutcomeSources): Promise<SessionSummary | undefined> {
  const find = (id: string) => sessions.find((session) => session.id === id || idOf(session) === id);
  const started = conversationsStartedBy(db, project.id, runSessionId).map((start) => find(start.childSessionId)).filter((session) => session !== undefined);
  if (started.length) return newest(started);
  const run = find(runSessionId);
  if (!run || run.running) return run;
  // Started before starts were recorded: the conversation the run's answer names by its id.
  const answer = await sources.lastAnswer(project, idOf(run));
  return newest(sessions.filter((session) => session !== run && answer.includes(idOf(session)))) ?? run;
}

interface Pass { db: DatabaseSync; actor: ActingAccount; settings: BobSettings; sources: OutcomeSources; projects: Map<string, ProjectRecord | undefined>; sessions: Map<string, SessionSummary[]> }

/** The call's project and the conversation working on it, once its run started. */
async function investigationFor(pass: Pass, trigger: Trigger): Promise<{ project: ProjectRecord; investigation: SessionSummary } | null> {
  const run = automationRunOf(pass.db, trigger.requestId!);
  if (!run?.sessionId || (run.status !== "running" && run.status !== "succeeded")) return null;
  if (!pass.projects.has(trigger.projectId)) pass.projects.set(trigger.projectId, await pass.sources.project(trigger.projectId, pass.actor));
  const project = pass.projects.get(trigger.projectId);
  if (!project) return null;
  if (!pass.sessions.has(project.id)) pass.sessions.set(project.id, await pass.sources.sessions(project, pass.actor));
  const investigation = await investigationOf(pass.db, project, pass.sessions.get(project.id)!, run.sessionId, pass.sources);
  return investigation ? { project, investigation } : null;
}

/** How the conversation's last answer leaves the call: judged once per answer; null when nothing could tell. */
async function outcomeOf(pass: Pass, trigger: Trigger, project: ProjectRecord, investigation: SessionSummary): Promise<OutcomeAnswer | null> {
  const answer = await pass.sources.lastAnswer(project, idOf(investigation));
  if (!answer) return null;
  const hash = answerDigest(answer);
  const known = knownOutcome(pass.db, project.id, idOf(investigation), hash);
  if (known) return known;
  const judged = await judgeOutcome(await pass.sources.deps(pass.actor, pass.settings, project), trigger, { title: investigation.title, answer }, pass.settings.threshold);
  if (judged) rememberOutcome(pass.db, project.id, idOf(investigation), hash, judged);
  return judged;
}

const LABELS: Record<OutcomeAnswer["outcome"], string> = { settled: "settled", "in-progress": "in hand", "needs-you": "needs you" };

/** One call, followed to its conversation: true when what the log says about it changed. */
async function follow(pass: Pass, trigger: Trigger): Promise<boolean> {
  const found = await investigationFor(pass, trigger);
  if (!found) return false;
  const { project, investigation } = found;
  const conversation = { conversationId: idOf(investigation), conversationTitle: investigation.title };
  // Closed by the person, or still working: no answer to judge.
  if (investigation.doneAt && !investigation.running) return noteTriggerOutcome(pass.db, trigger.id, { label: "settled", reason: "Its conversation was marked done.", ...conversation });
  if (investigation.running) return noteTriggerOutcome(pass.db, trigger.id, { label: "in hand", reason: "Its conversation is working on it.", ...conversation });
  const judged = await outcomeOf(pass, trigger, project, investigation);
  if (!judged) return false;
  return noteTriggerOutcome(pass.db, trigger.id, { label: LABELS[judged.outcome], reason: `${judged.reason} (${judged.by})`, ...conversation });
}

/** Follows one person's calls, newest first. Returns whether anything they see changed. */
export async function settleFollowedCalls(db: DatabaseSync, actor: ActingAccount, sources: OutcomeSources = realSources): Promise<boolean> {
  const settings = readBobSettings(db, actor.accountId);
  if (!settings.monitoring) return false;
  const pass: Pass = { db, actor, settings, sources, projects: new Map(), sessions: new Map() };
  let changed = false;
  for (const trigger of followedTriggers(db, actor.accountId)) {
    try { changed = await follow(pass, trigger) || changed; }
    catch (error) { console.warn(`Bob could not follow the call "${trigger.title}"`, error instanceof Error ? error.message : error); }
  }
  return changed;
}

// ── When ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Turns often end in a row: one check follows them. */
const SETTLE_DELAY_MS = 10_000;
let chain: Promise<void> = Promise.resolve();
let timer: NodeJS.Timeout | undefined;

async function settleEveryone(): Promise<void> {
  // Conversations are listed fully only once the server finished starting.
  if (!flags.startupReady) { settleSoon(); return; }
  const db = await triggerDatabase();
  for (const actor of listBobAccounts(db)) {
    if (await settleFollowedCalls(db, actor)) broadcastToAllClients({ type: "controlCenterChanged" }, actor.accountId);
  }
}

/** Checks again shortly; checks never overlap. */
export function settleSoon(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    chain = chain.then(settleEveryone).catch((error) => console.warn("Bob could not follow his webhook calls", error instanceof Error ? error.message : error));
  }, SETTLE_DELAY_MS).unref();
}

/** Calls stored before their run was kept with them are matched to it, so they can be followed too. */
async function matchOldCalls(): Promise<void> {
  const db = await triggerDatabase();
  const oldest = oldestUnmatchedTrigger(db);
  if (!oldest) return;
  const matched = matchTriggerRuns(db, webhookRunsSince(db, new Date(Date.parse(oldest) - 60_000).toISOString()));
  if (matched) console.log(`Bob matched ${matched} earlier webhook calls to their runs`);
}

let started = false;

/** Starts following webhook calls: once now, and whenever a turn ends in a project with calls to follow. */
export function startOutcomeChecks(): void {
  if (started) return;
  started = true;
  chain = chain.then(matchOldCalls).catch((error) => console.warn("Bob could not match earlier webhook calls", error instanceof Error ? error.message : error));
  settleSoon();
  onConversationTurn((shared) => {
    void triggerDatabase().then((db) => { if (followsCallsIn(db, shared.projectId)) settleSoon(); })
      .catch((error) => console.warn("Bob could not follow his webhook calls", error instanceof Error ? error.message : error));
  });
}
