import { existsSync } from "node:fs";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getGuardianSettings, updateGuardianSettings } from "../../guardian/settings.js";
import { productionGuardStatus, withProductionGuard } from "../../guardian/production-rule.js";
import { allPendingGuardianReviews, decideGuardianReview } from "../../guardian/reviews.js";
import { getProject, projectVisible } from "../../store.js";
import { isKeptOut, keepBobOut, loadKeptOut, releaseLease, takeLease } from "../../control-center/leases.js";
import { requireAdmin } from "../admin.js";
import { broadcastToAllClients } from "../realtime.js";
import { sendError } from "../http-auth.js";
import { actingAccountFromSession } from "../../account-context.js";
import { bobDatabase, countBobMessages, rememberBobAccount, type BobMessage } from "../../control-center/bob-store.js";
import { asideNow, conversationsOfMessage, listSnoozes, writeSnooze } from "../../control-center/snoozes.js";
import { overviewConversations } from "../../control-center/overview.js";
import { bobStartedKeys } from "../../control-center/started.js";
import { cardDetail } from "../../control-center/card-detail.js";
import { createMoveEnvironment } from "../../control-center/moves-runtime.js";
import { loadConversationMessages } from "../conversation-turns.js";
import { storedDigest } from "../../conversation-digest.js";
import { gitCommitHistory, gitStatus } from "../../git-review.js";
import { knowledgeDirectory, readSubjects } from "../../project-knowledge.js";
import { projectsWithSharedNames } from "../projects.js";
import { sharedProjectSessions } from "../sessions-helpers.js";
import { startMemorySync } from "../../control-center/memory-sync.js";
import { loadBoard, loadPast } from "../control-center-board.js";
import { loadSystemMessages } from "../control-center-system.js";
import { startControlCenterWatch } from "../control-center-watch.js";
import { closeFromBoard, pushFromBoard, replyFromBoard, startReviewChecks } from "../control-center-review-check.js";
import { BobActionError } from "../../control-center/bob-actions.js";
import { NotFoundError } from "../../not-found.js";
import { closeoutFeedbackSchema } from "../../conversation-closeout.js";
import { startBobRecheck } from "../control-center-recheck.js";
import { startBobSync } from "../../control-center/bob-sync.js";
import { app } from "../state.js";

/** What the control center board shows: running conversations and finished ones waiting for review, across every project the caller can see. */
startControlCenterWatch();
void bobDatabase().then(loadKeptOut);
startReviewChecks();
startBobSync();
startBobRecheck();
startMemorySync();

/** What waits for the person, for the badge on the control center's icon: open Guardian reviews and Bob's items with buttons still on them. */
app.get("/api/control-center/summary", async (_request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const db = await bobDatabase();
    // What the person put aside does not count: a review it already saw, and Bob's earlier items about it alone.
    const aside = asideNow(listSnoozes(db, session.accountId));
    const reviews = allPendingGuardianReviews().filter((review) => !aside.get(`${review.projectId}:${review.conversationId}`)?.reviewIds.includes(review.id));
    const visible = (await Promise.all(reviews.map((review) => projectVisible(review.projectId)))).filter(Boolean).length;
    const aboutAside = (message: Pick<BobMessage, "actions" | "createdAt">) => {
      const keys = conversationsOfMessage(message);
      return keys.length > 0 && keys.every((key) => { const snooze = aside.get(key); return snooze !== undefined && message.createdAt <= snooze.snoozedAt; });
    };
    response.json({ waiting: visible + countBobMessages(db, session.accountId, "important", aboutAside) });
  } catch (error) { next(error); }
});

app.get("/api/control-center/board", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    // Opening the control center is how Bob learns who to tell about things that happen later. The workspace's left column
    // reads the same board for its three groups (`?look=1`); a glance at those is not opening the control center.
    if (request.query.look !== "1") rememberBobAccount(await bobDatabase(), actingAccountFromSession(session));
    // `?earlier=1` also lists every conversation that is not on the board, for the workspace's Earlier group.
    const { cards, projects, earlier } = await loadBoard(session, { earlier: request.query.earlier === "1" });
    // The project's own color goes along: the board and Bob's chat draw each project in it.
    response.json({ cards, earlier, projects: projects.map((project) => ({ id: project.id, name: project.name, color: project.color ?? null })) });
  } catch (error) {
    next(error);
  }
});

/** Conversations marked done, for the list's Past view and its search. They are read when the person asks for them, not with the board. */
app.get("/api/control-center/past", async (_request, response, next) => {
  try { response.json({ conversations: await loadPast(response.locals.authSession as AuthSession) }); } catch (error) { next(error); }
});

/** What is wrong with this installation right now (a missing key, a harness nobody signed in, a machine that does not answer). */
app.get("/api/control-center/system", async (_request, response, next) => {
  try { response.json({ messages: await loadSystemMessages(response.locals.authSession as AuthSession) }); } catch (error) { next(error); }
});

const snoozeSchema = z.object({
  projectId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  action: z.enum(["snooze", "wake"]),
  /** When it comes back on its own; null keeps it aside until something new happens. Ignored when waking. */
  until: z.string().datetime({ offset: true }).nullable().default(null),
}).strict();

const MAX_SNOOZE_MS = 30 * 24 * 60 * 60 * 1_000;

/** Puts a Needs you card aside for now, or brings it back. Snoozes are the person's and follow them to their other machines. */
app.post("/api/control-center/snooze", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const input = snoozeSchema.parse(request.body);
    if (!await projectVisible(input.projectId)) { sendError(response, 404, "Project not found"); return; }
    const now = new Date();
    if (input.action === "snooze" && input.until !== null) {
      const until = Date.parse(input.until);
      if (until <= now.getTime() || until - now.getTime() > MAX_SNOOZE_MS) { sendError(response, 400, "Choose a time within the next 30 days"); return; }
    }
    const reviewIds = allPendingGuardianReviews().filter((review) => review.projectId === input.projectId && review.conversationId === input.conversationId).map((review) => review.id);
    const at = now.toISOString();
    writeSnooze(await bobDatabase(), {
      accountId: session.accountId, projectId: input.projectId, conversationId: input.conversationId,
      // Waking ends it now; the moment kept as its end keeps a late copy from another machine from putting it aside again.
      until: input.action === "wake" ? at : input.until === null ? null : new Date(input.until).toISOString(),
      snoozedAt: at, reviewIds, updatedAt: at,
    });
    broadcastToAllClients({ type: "controlCenterChanged" }, session.accountId);
    response.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid snooze"); return; }
    next(error);
  }
});

const decisionSchema = z.object({
  projectId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  reviewId: z.string().min(1).max(100),
  decision: z.enum(["allow", "block"]),
}).strict();

/** The person's answer to a Guardian review, from the board. Only a project they can see can be answered. */
app.post("/api/control-center/guardian/decide", async (request, response, next) => {
  try {
    const input = decisionSchema.parse(request.body);
    if (!await projectVisible(input.projectId) || !decideGuardianReview(input.projectId, input.conversationId, input.reviewId, input.decision)) {
      sendError(response, 404, "That review was already answered, or it timed out and was blocked");
      return;
    }
    response.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid answer"); return; }
    next(error);
  }
});

/** Whether production and destructive steps ask first on this machine. */
app.get("/api/control-center/guardian", (_request, response) => {
  response.json({ status: productionGuardStatus(getGuardianSettings()) });
});

/** Turns Guardian on with the production rule. Guardian is a machine setting, so only an administrator can. */
app.post("/api/control-center/guardian/protect", requireAdmin, (_request, response) => {
  response.json({ status: productionGuardStatus(updateGuardianSettings(withProductionGuard(getGuardianSettings()))) });
});

const leaseSchema = z.object({
  projectId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  action: z.enum(["take", "release", "keep-out", "let-in"]),
}).strict();

/**
 * Taking control of a conversation keeps Bob and auto respond out of it until it is given back. The page renews it while
 * the person stays in the conversation; a closed page lets it lapse after a minute. "keep-out" keeps Bob out for good, even
 * after the person closes it, until "let-in" or giving it back.
 */
app.post("/api/control-center/lease", async (request, response, next) => {
  try {
    const input = leaseSchema.parse(request.body);
    const session = response.locals.authSession as AuthSession;
    if (!await projectVisible(input.projectId)) { sendError(response, 404, "Project not found"); return; }
    if (input.action === "keep-out" || input.action === "let-in") {
      if (!keepBobOut(await bobDatabase(), input.projectId, input.conversationId, session.accountId, input.action === "keep-out")) { sendError(response, 409, "Someone else is in control of this conversation"); return; }
      broadcastToAllClients({ type: "controlCenterChanged" });
      response.json({ leased: true, keptOut: input.action === "keep-out" });
      return;
    }
    if (input.action === "release") {
      if (isKeptOut(input.projectId, input.conversationId)) keepBobOut(await bobDatabase(), input.projectId, input.conversationId, session.accountId, false);
      releaseLease(input.projectId, input.conversationId, session.accountId);
      broadcastToAllClients({ type: "controlCenterChanged" });
      response.json({ leased: false });
      return;
    }
    if (!takeLease(input.projectId, input.conversationId, session.accountId)) { sendError(response, 409, "Someone else is in control of this conversation"); return; }
    broadcastToAllClients({ type: "controlCenterChanged" });
    response.json({ leased: true, keptOut: isKeptOut(input.projectId, input.conversationId) });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request"); return; }
    next(error);
  }
});

const cardDoneSchema = z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(300), feedback: closeoutFeedbackSchema }).strict();

/** Done on a card: closes the conversation, stopping it first when it is working. */
app.post("/api/control-center/cards/done", async (request, response, next) => {
  try {
    const input = cardDoneSchema.parse(request.body);
    if (!await projectVisible(input.projectId)) { sendError(response, 404, "Project not found"); return; }
    await closeFromBoard(response.locals.authSession as AuthSession, input, input.feedback);
    response.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request"); return; }
    next(error);
  }
});

const cardPushSchema = z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(300), note: z.string().trim().max(4_000).optional() }).strict();

/** Push it on from a card (Home, the board): tells the conversation to go on, with the person's instructions when written. */
app.post("/api/control-center/cards/push", async (request, response, next) => {
  try {
    const input = cardPushSchema.parse(request.body);
    if (!await projectVisible(input.projectId)) { sendError(response, 404, "Project not found"); return; }
    await pushFromBoard(response.locals.authSession as AuthSession, input, input.note ?? "");
    response.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request"); return; }
    if (error instanceof BobActionError) { sendError(response, error.status, error.message); return; }
    if (error instanceof NotFoundError) { sendError(response, 404, error.message); return; }
    if (error instanceof Error && /not writable on this node|Team continuation/.test(error.message)) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

const cardReplySchema = z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(300), message: z.string().trim().min(1).max(8_000) }).strict();

/** Answer on a card: the person's words go to the conversation as written, without opening it. */
app.post("/api/control-center/cards/reply", async (request, response, next) => {
  try {
    const input = cardReplySchema.parse(request.body);
    if (!await projectVisible(input.projectId)) { sendError(response, 404, "Project not found"); return; }
    await replyFromBoard(response.locals.authSession as AuthSession, input, input.message);
    response.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request"); return; }
    if (error instanceof BobActionError) { sendError(response, error.status, error.message); return; }
    if (error instanceof NotFoundError) { sendError(response, 404, error.message); return; }
    if (error instanceof Error && /not writable on this node|Team continuation/.test(error.message)) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

const cardDetailSchema = z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(300) }).strict();

/**
 * What a card on Home waits for, read without opening the conversation: what was asked, the agent's last message and its last
 * steps. Read-only; a project or conversation the caller cannot see is not found, exactly as for the card's other actions.
 */
app.get("/api/control-center/cards/detail", async (request, response, next) => {
  try {
    const input = cardDetailSchema.parse(request.query);
    if (!await projectVisible(input.projectId)) { sendError(response, 404, "Project not found"); return; }
    const project = await getProject(input.projectId);
    if (!project || !await createMoveEnvironment(response.locals.authSession as AuthSession).resolve(input)) { sendError(response, 404, "Conversation not found"); return; }
    // A transcript still on another machine cannot be read here: the card says so and keeps its other reasons.
    const loaded = await loadConversationMessages(project, input.conversationId).catch(() => null);
    response.json(loaded ? cardDetail(loaded.messages) : { ...cardDetail([]), unavailable: true });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request"); return; }
    next(error);
  }
});

/** One project at a glance: its conversations as headlines, what changed recently, and what its knowledge holds. */
app.get("/api/control-center/overview", async (request, response, next) => {
  try {
    const { project: projectId } = z.object({ project: z.string().min(1).max(200) }).strict().parse(request.query);
    const session = response.locals.authSession as AuthSession;
    const project = (await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false })).find((candidate) => candidate.id === projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const [sessions, started] = await Promise.all([sharedProjectSessions(project, session.userId, session.accountId), bobStartedKeys()]);
    const conversations = overviewConversations(sessions, {
      summaryOf: (conversationId) => storedDigest(project.id, conversationId)?.summary ?? null,
      startedByBob: (sessionId, conversationId) => started.has(`${project.id}:${sessionId}`) || started.has(`${project.id}:${conversationId}`),
    });
    // A project that is not a git repository simply has no changes to show.
    const changes = await gitStatus(project.path).then(async (status) => ({
      branch: status.branch, ahead: status.ahead, behind: status.behind, uncommitted: status.staged.length + status.unstaged.length + status.untracked.length,
      commits: (await gitCommitHistory(project.path, 6)).map((commit) => ({ shortHash: commit.shortHash, subject: commit.subject, date: commit.date, author: commit.author })),
    }), () => null);
    const knowledge = existsSync(knowledgeDirectory(project.path)) ? readSubjects(project.path).map((subject) => ({ slug: subject.slug, description: subject.description, rules: subject.rules.length })) : [];
    response.json({ project: { id: project.id, name: project.name }, conversations, changes, knowledge });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid project"); return; }
    next(error);
  }
});
