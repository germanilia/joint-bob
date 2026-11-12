import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { BobActionError, runBobAction } from "../../control-center/bob-actions.js";
import { actingAccountFromSession } from "../../account-context.js";
import { bobDatabase, countBobMessages, getBobMessage, listBobMessages, readBobSettings, rememberBobAccount, writeBobSettings, type BobImportanceFilter } from "../../control-center/bob-store.js";
import { GitReviewRunError, handleBobMessage } from "../bob.js";
import { sendError } from "../http-auth.js";
import { QuickNoteLaunchError } from "../quick-note-dispatch.js";
import { fileAttachmentSchema, imageAttachmentSchema } from "../schemas.js";
import { appearanceContextSchema } from "../control-center-display.js";
import { replyToItem, settleItem } from "../control-center-items.js";
import { app } from "../state.js";
import { readReviewCheck } from "../../control-center/review-check.js";
import { lastReviewSkip } from "../control-center-review-check.js";
import { projectVisible } from "../../store.js";
// A press of a message another of the person's machines wrote is run there.
import "../control-center-bob-remote.js";

const messageSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  /** The person chose the project; it is not guessed. */
  projectId: z.string().min(1).max(200).optional(),
  /** Bob only answers: no task, move, dashboard or automation starts from this message. Used for text that came from outside. */
  answerOnly: z.boolean().optional(),
  /** Pasted or picked images and files, with the same limits as a conversation's message box. */
  images: z.array(imageAttachmentSchema).max(4).optional(),
  files: z.array(fileAttachmentSchema).max(6).optional(),
  /** The page's own display settings and what it allows, so Bob's display agent can change them there. */
  appearance: appearanceContextSchema.optional(),
}).strict();

const settingsSchema = z.object({
  harnessId: z.string().max(60),
  provider: z.string().max(200),
  modelId: z.string().max(300),
  thinkingLevel: z.string().max(40),
  threshold: z.number().min(0).max(1),
  classifier: z.enum(["typesafe", "laya"]),
  monitoring: z.boolean(),
  askBeforeSaving: z.boolean(),
  autoRespond: z.enum(["bob", "always", "never"]),
  reviewCheck: z.enum(["push", "ask", "off"]),
  systemControl: z.boolean(),
  systemInstructions: z.string().max(20_000),
}).partial().strict();

const querySchema = z.object({
  project: z.string().min(1).max(200).optional(),
  importance: z.enum(["important", "reports", "fyi"]).optional(),
  /** Only the items that were cleared, with why. */
  cleared: z.literal("1").optional(),
}).strict();

app.get("/api/control-center/bob/settings", async (_request, response, next) => {
  try {
    response.json(readBobSettings(await bobDatabase(), (response.locals.authSession as AuthSession).accountId));
  } catch (error) { next(error); }
});

app.put("/api/control-center/bob/settings", async (request, response, next) => {
  try {
    const change = settingsSchema.parse(request.body);
    const session = response.locals.authSession as AuthSession, db = await bobDatabase();
    // Setting Bob up makes the person one of Bob's: what he does for them (system control's reports) reaches their chat.
    rememberBobAccount(db, actingAccountFromSession(session));
    response.json(writeBobSettings(db, session.accountId, change));
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid settings for Bob"); return; }
    next(error);
  }
});

/**
 * Bob's last check of one conversation, for the conversation itself: the verdict, why, and which model decided (`by`), or why he
 * passed over its last turn without judging it. A project the caller cannot see is not found.
 */
app.get("/api/control-center/bob/review-check", async (request, response, next) => {
  try {
    const { projectId, conversationId } = z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(300) }).strict().parse(request.query);
    if (!await projectVisible(projectId)) { sendError(response, 404, "Project not found"); return; }
    const check = readReviewCheck(await bobDatabase(), projectId, conversationId);
    response.json({
      check: check ? { verdict: check.verdict, reason: check.reason, by: check.by, pushes: check.pushes, needsYou: check.needsYou, checkedAt: check.checkedAt } : null,
      skipped: lastReviewSkip(projectId, conversationId),
    });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request"); return; }
    next(error);
  }
});

app.get("/api/control-center/bob/messages", async (request, response, next) => {
  try {
    const query = querySchema.parse(request.query);
    const session = response.locals.authSession as AuthSession;
    const db = await bobDatabase();
    response.json({
      messages: listBobMessages(db, session.accountId, { project: query.project, importance: query.importance, cleared: query.cleared === "1" }),
      waiting: countBobMessages(db, session.accountId, "important" as BobImportanceFilter),
    });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid filter"); return; }
    next(error);
  }
});

/** What the person may write with a press: instructions for Push it on. */
const NOTE_CHARACTERS = 4_000;

app.post("/api/control-center/bob/action", async (request, response, next) => {
  try {
    const { messageId, actionId, note } = z.object({ messageId: z.string().min(1).max(100), actionId: z.string().min(1).max(100), note: z.string().trim().max(NOTE_CHARACTERS).optional() }).strict().parse(request.body);
    const session = response.locals.authSession as AuthSession;
    const db = await bobDatabase();
    const messages = await runBobAction(db, session, messageId, actionId, note ?? "");
    // The pressed item as it is now: cleared, or (a button that only opens something) still waiting with its buttons.
    response.json({ messages, pressed: getBobMessage(db, session.accountId, messageId) });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid action"); return; }
    if (error instanceof BobActionError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

/** Any message of Bob's, settled by the person: dismissed, done (its conversation closed), or answered by a message to Bob. */
app.post("/api/control-center/bob/item", async (request, response, next) => {
  try {
    const { messageId, how } = z.object({ messageId: z.string().min(1).max(100), how: z.enum(["dismiss", "done", "answered"]) }).strict().parse(request.body);
    response.json({ pressed: await settleItem(await bobDatabase(), response.locals.authSession as AuthSession, messageId, how) });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request"); return; }
    if (error instanceof BobActionError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

/** A quick reply to a message about a conversation: it goes into that conversation as the person. */
app.post("/api/control-center/bob/reply", async (request, response, next) => {
  try {
    const { messageId, text } = z.object({ messageId: z.string().min(1).max(100), text: z.string().trim().min(1).max(20_000) }).strict().parse(request.body);
    response.json({ pressed: await replyToItem(await bobDatabase(), response.locals.authSession as AuthSession, messageId, text) });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid reply"); return; }
    if (error instanceof BobActionError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.post("/api/control-center/bob/message", async (request, response, next) => {
  try {
    const input = messageSchema.parse(request.body);
    response.json(await handleBobMessage(response.locals.authSession as AuthSession, input));
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid message for Bob"); return; }
    if (error instanceof GitReviewRunError || error instanceof QuickNoteLaunchError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

