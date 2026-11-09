import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { triageQuestion } from "../../control-center/triggers-brief.js";
import { dismissTriggers, getTrigger, listTriggers, publicTrigger, type Trigger } from "../../control-center/triggers-store.js";
import { projectVisible } from "../../store.js";
import { clearWebhookItemsFromChat, triggerDatabase } from "../control-center-triggers.js";
import { startOutcomeChecks } from "../control-center-outcomes.js";
import { sendError } from "../http-auth.js";
import { broadcastToAllClients } from "../realtime.js";
import { app, server } from "../state.js";

// The webhook log: what webhooks received, and how the conversation each call started ended. It is read in the control
// center; nothing of it goes to Bob's chat.

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  size: z.coerce.number().int().min(1).max(50).default(10),
}).strict();
const ids = z.array(z.string().min(1).max(100)).min(1).max(200);
const dismissBody = z.union([z.object({ ids }).strict(), z.object({ all: z.literal(true) }).strict()]);

const accountOf = (response: Response): string => (response.locals.authSession as AuthSession).accountId;

function route(work: (request: Request, response: Response) => Promise<void>) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try { await work(request, response); } catch (error) {
      if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request for the webhook log"); return; }
      next(error);
    }
  };
}

/** What this person can still see: calls whose project they can still open. */
async function listed(accountId: string): Promise<Trigger[]> {
  const found = listTriggers(await triggerDatabase(), accountId);
  const visible = new Map<string, boolean>();
  for (const projectId of new Set(found.map((trigger) => trigger.projectId))) visible.set(projectId, await projectVisible(projectId));
  return found.filter((trigger) => visible.get(trigger.projectId));
}

/** One page of the log, newest first. */
app.get("/api/control-center/triggers", route(async (request, response) => {
  const query = listQuery.parse(request.query);
  const found = await listed(accountOf(response));
  response.json({ triggers: found.slice((query.page - 1) * query.size, query.page * query.size).map(publicTrigger), total: found.length });
}));

/** What the person says to Bob to have it triage one call. The page sends it through Bob's chat like anything they type. */
app.get("/api/control-center/triggers/:id/triage", route(async (request, response) => {
  const accountId = accountOf(response);
  const trigger = getTrigger(await triggerDatabase(), accountId, z.string().min(1).max(100).parse(request.params.id));
  if (!trigger || trigger.state === "dismissed" || !await projectVisible(trigger.projectId)) { sendError(response, 404, "That call is no longer in the log"); return; }
  response.json({ message: triageQuestion(trigger), projectId: trigger.projectId });
}));

/** Clears the named calls from the log, or all of them. */
app.post("/api/control-center/triggers/dismiss", route(async (request, response) => {
  const accountId = accountOf(response);
  const body = dismissBody.parse(request.body);
  const dismissed = dismissTriggers(await triggerDatabase(), accountId, "ids" in body ? body.ids : "all");
  if (dismissed) broadcastToAllClients({ type: "controlCenterChanged" }, accountId);
  response.json({ dismissed });
}));

// What webhook calls left in Bob's chat before the log leaves it; then each call is followed to the conversation its run
// started, and the log notes how that ended.
server.once("listening", () => {
  void clearWebhookItemsFromChat().catch((error) => console.warn("Could not clear webhook calls from Bob's chat", error instanceof Error ? error.message : error));
  startOutcomeChecks();
});
