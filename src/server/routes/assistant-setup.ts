import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getSetupSecret, openAssistantSetup, requestSetupSecret, settleSetupSecret, type SetupSecretRequest } from "../../assistant-setup.js";
import { announceAssistantChanges } from "../../assistant-collaboration/twin-sync.js";
import { actingAccountFromSession, runAsAccount } from "../../account-context.js";
import { browserRuntime } from "../browser.js";
import { registerBobAction } from "../../control-center/bob-actions.js";
import { appendBobMessage, bobDatabase, resolveBobMessage } from "../../control-center/bob-store.js";
import { assistantLoginProfileIds, getPersonalAssistantById, personalAssistantDatabase, savePersonalAssistant, type PersonalAssistant } from "../../personal-assistants.js";
import { conversationScopeId, getScopeSecretAccounts, persistConversationSecretAccounts, saveSecretAccount, type ConversationEngineId } from "../../secrets.js";
import { WebhookResourceError } from "../../webhook-resources.js";
import { listWebhookSkills, uploadWebhookSkill, WEBHOOK_SKILL_MAX_FILES } from "../../webhook-skills.js";
import { broadcastToAllClients } from "../realtime.js";
import { app } from "../state.js";
import { sendError } from "../http-auth.js";
import { syncAssistantLoginGrants } from "./assistant-resources.js";

// The agent's side of an assistant's setup (the capability token names the assistant, never the request), and the person's
// side of what it asks them for.

export const SETUP_SECRET_ACTION = "assistant-setup.secret";
const SETUP_SECRET_DECLINE = "assistant-setup.secret-decline";

const variableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100);
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("instructions"), content: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ action: z.literal("skill"), files: z.array(z.object({ relativePath: z.string().min(1).max(1000), data: z.string().max(5_592_408) }).strict()).min(1).max(WEBHOOK_SKILL_MAX_FILES) }).strict(),
  z.object({ action: z.literal("login"), profileId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("secret"), label: z.string().trim().min(1).max(64), why: z.string().trim().min(1).max(2000), names: z.array(variableName).min(1).max(20) }).strict(),
  z.object({ action: z.literal("secret-status"), id: z.string().uuid() }).strict(),
]);

const secretView = (request: SetupSecretRequest) => ({ id: request.id, status: request.status, label: request.label, names: request.names });

/** Installs the folder as the assistant's own skill; a skill of the same name from an earlier try is replaced. */
async function installSkill(assistant: PersonalAssistant, files: Array<{ relativePath: string; data: string }>) {
  const db = await personalAssistantDatabase();
  const decoded = files.map((file) => ({ relativePath: file.relativePath, data: Buffer.from(file.data, "base64") }));
  try { return await uploadWebhookSkill(db, assistant.id, decoded); }
  catch (error) {
    const taken = error instanceof WebhookResourceError && error.statusCode === 409 ? /skill named (.+)$/.exec(error.message)?.[1] : undefined;
    const existing = taken ? listWebhookSkills(db, assistant.id).find((skill) => skill.name === taken) : undefined;
    if (!existing) throw error;
    return uploadWebhookSkill(db, assistant.id, decoded, {}, existing.id);
  }
}

/** Attaches a browser profile the setup conversation started itself, so the assistant's later conversations are signed in with it. */
async function attachLogin(assistant: PersonalAssistant, profileId: string): Promise<void> {
  const ownedHere = browserRuntime().profileGrants(profileId).some((grant) => grant.scope === "conversation" && grant.projectId === assistant.projectId && grant.conversationId === assistant.sessionId);
  if (!ownedHere) throw new WebhookResourceError("That browser profile was not started by this conversation", 404);
  const db = await personalAssistantDatabase();
  db.prepare("INSERT OR IGNORE INTO personal_assistant_logins (assistant_id, profile_id, created_at) VALUES (?,?,?)").run(assistant.id, profileId, new Date().toISOString());
  await syncAssistantLoginGrants(assistant.id, assistant.accountId);
}

/** Asks the person for secret values in Bob's chat: the button opens a box, and the values never pass through the agent. */
async function askForSecret(assistant: PersonalAssistant, input: { label: string; why: string; names: string[] }): Promise<SetupSecretRequest> {
  const request = requestSetupSecret(assistant.id, assistant.accountId, input);
  appendBobMessage(await bobDatabase(), assistant.accountId, {
    role: "bob", importance: "needs-you", via: "Assistant setup · needs a secret",
    text: `"${assistant.name}" needs ${input.label} to be set up.\n${input.why}\n\nIt asks for: ${input.names.join(", ")}. What you enter goes to Secrets, attached to this assistant; the agent never sees it.`,
    actions: [
      { id: SETUP_SECRET_ACTION, label: "Enter it", style: "primary", data: { secretRequest: { id: request.id, label: input.label, why: input.why, names: input.names, assistantName: assistant.name } } },
      { id: SETUP_SECRET_DECLINE, label: "I don't have it", data: { requestId: request.id } },
    ],
  });
  broadcastToAllClients({ type: "controlCenterChanged" }, assistant.accountId);
  return request;
}

app.post("/api/assistant-agent/setup", async (request, response, next) => {
  try {
    const assistantId = response.locals.assistantSetupAgent as string | undefined;
    const assistant = assistantId ? await getPersonalAssistantById(assistantId) : undefined;
    if (!assistant) { sendError(response, 403, "Assistant setup capability required"); return; }
    const command = commandSchema.parse(request.body);
    if (command.action === "status") {
      const db = await personalAssistantDatabase();
      response.json({
        name: assistant.name, purpose: openAssistantSetup(assistant.id)!.purpose, hasInstructions: Boolean(assistant.instructions.trim()),
        skills: listWebhookSkills(db, assistant.id).map((skill) => skill.name), logins: await assistantLoginProfileIds(assistant.id),
      });
    } else if (command.action === "instructions") {
      await savePersonalAssistant(assistant.accountId, { ...assistant, instructions: command.content }, assistant.id);
      response.json({ saved: true });
    } else if (command.action === "skill") {
      const skill = await installSkill(assistant, command.files);
      response.json({ installed: skill.name });
    } else if (command.action === "login") {
      await attachLogin(assistant, command.profileId);
      response.json({ attached: command.profileId });
    } else if (command.action === "secret") {
      response.json(secretView(await askForSecret(assistant, command)));
    } else {
      const found = getSetupSecret(command.id);
      if (!found || found.assistantId !== assistant.id) { sendError(response, 404, "Request not found"); return; }
      response.json(secretView(found));
    }
    if (command.action !== "status" && command.action !== "secret-status") announceAssistantChanges();
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid setup command"); return; }
    if (error instanceof WebhookResourceError) { sendError(response, error.statusCode, error.message); return; }
    next(error);
  }
});

const valuesSchema = z.object({ messageId: z.string().min(1).max(100), values: z.record(variableName, z.string().min(1).max(20_000)) }).strict();

/**
 * The person's answer to a secret request: the values become a secret account of theirs, attached to the assistant's
 * conversation, and the waiting setup goes on. The values are written once, here, and are not kept anywhere else.
 */
app.post("/api/control-center/assistant-setup/secrets/:id", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const input = valuesSchema.parse(request.body);
    const found = getSetupSecret(z.string().uuid().parse(request.params.id));
    if (!found || found.accountId !== session.accountId) { sendError(response, 404, "Request not found"); return; }
    if (found.status !== "waiting" || !openAssistantSetup(found.assistantId)) { sendError(response, 409, "This request is no longer waiting"); return; }
    if (found.names.some((name) => !input.values[name]) || Object.keys(input.values).length !== found.names.length) { sendError(response, 400, "Enter every value it asks for"); return; }
    const assistant = await getPersonalAssistantById(found.assistantId);
    if (!assistant) { sendError(response, 404, "Assistant not found"); return; }
    await runAsAccount(actingAccountFromSession(session), async () => {
      const account = await saveSecretAccount({ label: found.label, provider: "custom", variables: found.names.map((name) => ({ name, kind: "value", value: input.values[name] })) });
      const engine = assistant.engine as ConversationEngineId;
      const attached = (await getScopeSecretAccounts("conversation", conversationScopeId(engine, assistant.sessionId))).accountIds;
      await persistConversationSecretAccounts(engine, assistant.sessionId, [...attached, account.id]);
    });
    settleSetupSecret(found.id, "saved");
    resolveBobMessage(await bobDatabase(), session.accountId, input.messageId, "You entered it");
    broadcastToAllClients({ type: "controlCenterChanged" }, session.accountId);
    response.json({ saved: true });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Enter every value it asks for"); return; }
    next(error);
  }
});

// The dialog answers "Enter it" through the route above; pressing it without the dialog changes nothing.
registerBobAction(SETUP_SECRET_ACTION, async () => undefined);
registerBobAction(SETUP_SECRET_DECLINE, async ({ action, session }) => {
  const { requestId } = z.object({ requestId: z.string().uuid() }).parse(action.data);
  const found = getSetupSecret(requestId);
  if (found?.accountId === session.accountId) settleSetupSecret(requestId, "declined");
});
