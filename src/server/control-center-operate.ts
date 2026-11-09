import { z } from "zod";
import { actingAccountFromSession, runAsAccount } from "../account-context.js";
import type { AuthSession } from "../auth.js";
import { bobAutoRespondConfig } from "../control-center/auto-respond.js";
import { bobSays, registerBobAction } from "../control-center/bob-actions.js";
import { readBobSettings, type BobSettings } from "../control-center/bob-store.js";
import { createMoveEnvironment } from "../control-center/moves-runtime.js";
import { disableAutoRespond, enableAutoRespond, getAutoRespond } from "../conversation-auto-respond.js";
import { listHarnessModels } from "../harnesses.js";
import type { HarnessModel } from "../harnesses/runtime.js";
import { createQuickNote } from "../quick-notes.js";
import { getScopeSecretAccounts } from "../secrets.js";
import { getProject } from "../store.js";
import { createTask } from "../tasks.js";
import { isHarnessId } from "../types.js";
import { observeAutoResponder } from "./auto-respond-recovery.js";
import { configureConversation } from "./conversation-prompt.js";
import { iconHarnessId } from "./label-icon.js";
import { assertProjectEditable } from "./projects.js";
import { broadcastToProject } from "./realtime.js";
import { projectGitOverview, projectGithubAction, projectPull, type ProjectPull } from "./routes/git-review.js";
import { attachConversationSecretAsActor } from "./routes/secrets.js";
import { startTaskRun } from "./task-runs.js";

// Bob operates more of the app for the person, beside arranging their work (control-center-organize.ts): he stops a
// conversation, turns its auto respond on or off, changes its agent, model or effort, attaches a secret account to it, shows a
// project's git and acts on its pull requests, and adds a task or a quick note. Each change waits for the person's button and
// runs as them, through the same functions the app's own screens use; looking at git changes nothing, so Bob answers it at once.

const id = z.string().min(1).max(240);
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const operateIntentShapes = [
  z.object({ intent: z.literal("stop-conversation"), conversation: id }),
  z.object({ intent: z.literal("auto-respond"), conversation: id, on: z.boolean() }),
  z.object({ intent: z.literal("change-model"), conversation: id, agent: z.string().min(1).max(40).nullable(), model: z.string().trim().min(1).max(200).nullable(), effort: z.enum(EFFORTS).nullable() }),
  z.object({ intent: z.literal("attach-secret"), conversation: id, accountId: id }),
  z.object({ intent: z.literal("git-status"), projectId: id }),
  z.object({ intent: z.literal("pull-request"), projectId: id, number: z.number().int().positive(), action: z.enum(["merge", "close", "reopen", "comment", "approve"]), body: z.string().max(20_000) }),
  z.object({ intent: z.literal("add-task"), projectId: id, title: z.string().trim().min(1).max(200), description: z.string().max(20_000), start: z.boolean() }),
  z.object({ intent: z.literal("add-note"), projectId: id, title: z.string().trim().min(1).max(120), content: z.string().max(100_000) }),
] as const;
export type OperateIntent = z.infer<(typeof operateIntentShapes)[number]>;
export const OPERATE_INTENTS = new Set<string>(operateIntentShapes.map((shape) => shape.shape.intent.value));

export const OPERATE_INSTRUCTIONS = [
  '{"intent":"stop-conversation","conversation":"<key>"} to stop what a listed conversation is doing now (its running turn).',
  '{"intent":"auto-respond","conversation":"<key>","on":true} to turn auto respond on for a listed conversation, or "on":false to turn it off.',
  '{"intent":"change-model","conversation":"<key>","agent":"<agent id>","model":"<the model as the user named it>","effort":"off|minimal|low|medium|high|xhigh|max"} to change the agent, model or reasoning effort a listed conversation uses; null for each one the user did not name.',
  '{"intent":"attach-secret","conversation":"<key>","accountId":"<secret account id>"} to attach one of the secret accounts listed to a listed conversation.',
  '{"intent":"git-status","projectId":"<id>"} when the user asks where a project\'s git stands: its branch, its changes, its open pull requests.',
  '{"intent":"pull-request","projectId":"<id>","number":123,"action":"merge|close|reopen|comment|approve","body":"<the comment, or empty>"} to act on one of a project\'s GitHub pull requests, by its number.',
  '{"intent":"add-task","projectId":"<id>","title":"...","description":"what the task should do, in the user\'s words","start":false} to add a task to a project\'s Tasks list; "start":true only when the user asks to start it now.',
  '{"intent":"add-note","projectId":"<id>","title":"...","content":"..."} to save a quick note in a project, to start later.',
];

/** What Bob may name beside the organize lists: the person's secret accounts, and the agents this machine runs. */
export interface OperateWorld {
  projects: Array<{ id: string; name: string }>;
  conversations: Array<{ key: string; projectId: string; projectName: string; engine: string; sessionId: string; conversationId: string; title: string; nodeId: string | null }>;
  accounts: Array<{ id: string; label: string; provider: string; projectId: string | null }>;
  agents: Array<{ id: string; label: string }>;
}

const conversationRef = { projectId: id, engine: z.string().min(1), sessionId: id, conversationId: id, title: z.string() };
export const operationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("stop-conversation"), ...conversationRef }),
  z.object({ op: z.literal("auto-respond"), ...conversationRef, on: z.boolean() }),
  z.object({ op: z.literal("change-model"), ...conversationRef, agent: z.string().nullable(), provider: z.string().nullable(), modelId: z.string().nullable(), effort: z.enum(EFFORTS).nullable() }),
  z.object({ op: z.literal("attach-secret"), ...conversationRef, accountId: id, accountLabel: z.string() }),
  z.object({ op: z.literal("pull-request"), projectId: id, number: z.number().int().positive(), title: z.string(), action: z.enum(["merge", "close", "reopen", "comment", "approve"]), body: z.string(), sha: z.string() }),
  z.object({ op: z.literal("add-task"), projectId: id, title: z.string().min(1).max(200), description: z.string().max(20_000), start: z.boolean() }),
  z.object({ op: z.literal("add-note"), projectId: id, title: z.string().min(1).max(120), content: z.string().max(100_000) }),
]);
export type Operation = z.infer<typeof operationSchema>;

type Place = { id: string; name: string };
/** A question with a button, or an answer. */
export type Offer = { text: string; project: Place | null } & ({ ask: true; button: string; danger: boolean; operation: Operation } | { ask: false; via: string });

const answer = (text: string, project: Place | null = null, via = "Organize · nothing to do"): Offer => ({ ask: false, text, project, via });
const ask = (text: string, button: string, operation: Operation, project: Place | null, danger = false): Offer => ({ ask: true, text, button, danger, operation, project });
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const problem = (error: unknown): string => error instanceof Error ? error.message.slice(0, 200) : String(error);

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The model the person named, among an agent's: the one whose id or name is it, else the only one that contains it. A list when several do. */
export function pickModel(models: HarnessModel[], named: string): HarnessModel | HarnessModel[] | null {
  const wanted = squash(named);
  const names = (model: HarnessModel) => [model.id, model.label, `${model.provider}/${model.id}`].map(squash);
  const exact = models.filter((model) => names(model).includes(wanted));
  if (exact.length === 1) return exact[0];
  const partial = (exact.length ? exact : models).filter((model) => names(model).some((name) => name.includes(wanted)));
  if (partial.length === 1) return partial[0];
  return partial.length ? partial : null;
}

/** What a git status says, in a few lines: the branch, how it stands with its upstream, its changes, and its open pull requests. */
export function gitStatusText(projectName: string, overview: Awaited<ReturnType<typeof projectGitOverview>>): string {
  const { status, pulls, pullsProblem } = overview;
  const branch = status.detached ? "a detached HEAD" : `the branch ${status.branch}`;
  const upstream = status.upstream ? `, ${status.ahead} ahead and ${status.behind} behind ${status.upstream}` : ", with no upstream branch";
  const changes = status.clean ? "No changes are waiting." : `Changes waiting: ${[status.staged.length && `${status.staged.length} staged`, status.unstaged.length && `${status.unstaged.length} not staged`, status.untracked.length && `${status.untracked.length} new`].filter(Boolean).join(", ")}.`;
  const shown = (pull: ProjectPull) => `- #${pull.number} ${pull.title} (${pull.head} → ${pull.base}${pull.draft ? ", draft" : ""}${pull.author ? `, by ${pull.author}` : ""})`;
  const open = pulls === null ? [`I could not read its pull requests: ${pullsProblem}`]
    : pulls.length ? [`Open pull requests (${pulls.length}):`, ...pulls.slice(0, 10).map(shown)] : ["No pull requests are open."];
  return [`${projectName} is on ${branch}${upstream}. ${changes}`, ...open].join("\n");
}

async function offerChangeModel(intent: Extract<OperateIntent, { intent: "change-model" }>, found: OperateWorld["conversations"][number], world: OperateWorld, place: Place): Promise<Offer> {
  const ref = { projectId: found.projectId, engine: found.engine, sessionId: found.sessionId, conversationId: found.conversationId, title: found.title };
  const agent = intent.agent && intent.agent !== found.engine ? world.agents.find((entry) => entry.id === intent.agent) : null;
  if (intent.agent && intent.agent !== found.engine && !agent) return answer(`This machine does not run that agent. It runs ${world.agents.map((entry) => entry.label).join(", ")}.`, place);
  if (!agent && !intent.model && !intent.effort) return answer(`Which agent, model or effort should "${found.title}" use?`, place);
  const harness = agent?.id ?? found.engine;
  let model: HarnessModel | null = null;
  if (intent.model) {
    const picked = isHarnessId(harness) ? pickModel(await listHarnessModels(harness), intent.model) : null;
    if (!picked) return answer(`I could not find the model "${intent.model}" for ${agent?.label ?? "its agent"}.`, place);
    if (Array.isArray(picked)) return answer(`"${intent.model}" could be ${picked.slice(0, 6).map((entry) => entry.label).join(", ")}. Which one?`, place);
    model = picked;
  }
  if (intent.effort && model && !model.thinkingLevels.includes(intent.effort)) return answer(`${model.label} does not take the effort "${intent.effort}"; it takes ${model.thinkingLevels.join(", ")}.`, place);
  const parts = [agent && `the agent ${agent.label}`, model && `the model ${model.label}`, intent.effort && `${intent.effort} effort`].filter(Boolean).join(", ");
  const note = agent ? " Another agent goes on in the conversation's next part, with what was said so far." : "";
  return ask(`Change "${found.title}" in ${found.projectName} to ${parts}?${note}`, "Change it", { op: "change-model", ...ref, agent: agent?.id ?? null, provider: model?.provider ?? null, modelId: model?.id ?? null, effort: intent.effort }, place);
}

async function offerForConversation(session: AuthSession, intent: Extract<OperateIntent, { conversation: string }>, world: OperateWorld): Promise<Offer> {
  const found = world.conversations.find((entry) => entry.key === intent.conversation);
  if (!found) return answer("I could not find that conversation.");
  const place = { id: found.projectId, name: found.projectName };
  const ref = { projectId: found.projectId, engine: found.engine, sessionId: found.sessionId, conversationId: found.conversationId, title: found.title };
  if (intent.intent === "stop-conversation") {
    const now = await createMoveEnvironment(session).resolve({ projectId: found.projectId, conversationId: found.conversationId });
    if (!now?.turnRunning) return answer(`"${found.title}" is not running anything right now.`, place);
    return ask(`Stop what "${found.title}" in ${found.projectName} is doing now? Its turn stops, as its stop button does; what is queued after it still runs.`, "Stop it", { op: "stop-conversation", ...ref }, place, true);
  }
  if (intent.intent === "attach-secret") {
    const account = world.accounts.find((entry) => entry.id === intent.accountId);
    if (!account) return answer("I could not find that secret account.", place);
    if (account.projectId && account.projectId !== found.projectId) return answer(`"${account.label}" belongs to another project, so it cannot be attached to "${found.title}".`, place);
    if ((await getScopeSecretAccounts("conversation", `${found.engine}:${found.sessionId}`)).accountIds.includes(account.id)) return answer(`"${account.label}" is already attached to "${found.title}".`, place);
    return ask(`Attach the secret account "${account.label}" to "${found.title}" in ${found.projectName}? Its next shell commands get it, and its agent from its next message.`, "Attach it", { op: "attach-secret", ...ref, accountId: account.id, accountLabel: account.label }, place);
  }
  // Auto respond and the model are kept, and run, on the machine that runs the conversation.
  if (found.nodeId) return answer(`"${found.title}" runs on another machine, so I cannot change that from here. Ask me on that machine, or open it there.`, place);
  if (intent.intent === "auto-respond") {
    const state = await getAutoRespond(found.projectId, found.conversationId);
    if (intent.on === (state?.status === "active")) return answer(`Auto respond is already ${intent.on ? "on" : "off"} for "${found.title}".`, place);
    return intent.on
      ? ask(`Turn auto respond on for "${found.title}" in ${found.projectName}? I'll answer its routine questions with my settings, and it stops for anything that needs you.`, "Turn it on", { op: "auto-respond", ...ref, on: true }, place)
      : ask(`Turn auto respond off for "${found.title}" in ${found.projectName}? It waits for you after each turn.`, "Turn it off", { op: "auto-respond", ...ref, on: false }, place);
  }
  return offerChangeModel(intent, found, world, place);
}

async function offerForPull(intent: Extract<OperateIntent, { intent: "pull-request" }>, place: Place): Promise<Offer> {
  if (intent.action === "comment" && !intent.body.trim()) return answer(`What should the comment on #${intent.number} say?`, place);
  let pull: ProjectPull | null;
  try {
    pull = await projectPull(place.id, intent.number, intent.action === "reopen" ? "closed" : "open");
  } catch (error) {
    return answer(`I could not read the pull requests of ${place.name}: ${problem(error)}.`, place);
  }
  if (!pull) return answer(`I could not find pull request #${intent.number} among the newest ${intent.action === "reopen" ? "closed" : "open"} ones of ${place.name}.`, place);
  const operation: Operation = { op: "pull-request", projectId: place.id, number: pull.number, title: pull.title, action: intent.action, body: intent.body.trim(), sha: pull.sha };
  const name = `#${pull.number} "${pull.title}" (${pull.head} → ${pull.base})`;
  switch (intent.action) {
    case "merge": return ask(`Merge ${name} in ${place.name}? It merges what the pull request holds now, and nothing that is pushed after this.`, "Merge it", operation, place, true);
    case "close": return ask(`Close ${name} in ${place.name} without merging it?`, "Close it", operation, place, true);
    case "reopen": return ask(`Reopen ${name} in ${place.name}?`, "Reopen it", operation, place);
    case "approve": return ask(`Approve ${name} in ${place.name}, as you?${operation.body ? `\n${operation.body.slice(0, 600)}` : ""}`, "Approve it", operation, place);
    case "comment": return ask(`Comment on ${name} in ${place.name}, as you?\n${operation.body.slice(0, 600)}`, "Comment", operation, place);
  }
}

/** What an operation would do, said plainly, or the answer when there is nothing to press. Only what is in the person's world gets this far. */
export async function offerOperation(session: AuthSession, intent: OperateIntent, world: OperateWorld): Promise<Offer> {
  if ("conversation" in intent) return offerForConversation(session, intent, world);
  const found = world.projects.find((entry) => entry.id === intent.projectId);
  if (!found) return answer("I could not find that project.");
  const place = { id: found.id, name: found.name };
  switch (intent.intent) {
    case "git-status": {
      try {
        return answer(gitStatusText(found.name, await projectGitOverview(found.id)), place, "Organize · git");
      } catch (error) {
        return answer(`I could not read the git of ${found.name} here: ${problem(error)}. Its folder may be on another machine; ask me there.`, place, "Organize · git");
      }
    }
    case "pull-request": return offerForPull(intent, place);
    case "add-task": return ask(`${intent.start ? "Add and start" : "Add"} the task "${intent.title}" in ${found.name}'s Tasks list?${intent.description ? `\n${intent.description.slice(0, 600)}` : ""}`, intent.start ? "Add and start" : "Add it", { op: "add-task", projectId: found.id, title: intent.title, description: intent.description, start: intent.start }, place);
    case "add-note": return ask(`Save the quick note "${intent.title}" in ${found.name}, to start later?${intent.content ? `\n${intent.content.slice(0, 600)}` : ""}`, "Save it", { op: "add-note", projectId: found.id, title: intent.title, content: intent.content }, place);
  }
}

async function runOnConversation(session: AuthSession, settings: BobSettings, operation: Extract<Operation, { conversationId: string }>): Promise<string> {
  const options = { projectId: operation.projectId, engine: operation.engine, sessionId: operation.sessionId, label: "Bob" };
  switch (operation.op) {
    case "stop-conversation": {
      const env = createMoveEnvironment(session);
      const now = await env.resolve({ projectId: operation.projectId, conversationId: operation.conversationId });
      if (!now?.turnRunning) return `"${operation.title}" had already stopped.`;
      await env.stopTurn(now, (await env.nodes()).find((node) => node.id === now.ownerNodeId) ?? null);
      return `Stopped "${operation.title}".`;
    }
    case "auto-respond": {
      if (!operation.on) {
        await disableAutoRespond(operation.projectId, operation.conversationId);
        return `Auto respond is off for "${operation.title}". It waits for you after each turn.`;
      }
      if (!isHarnessId(operation.engine)) throw new Error("That conversation's agent is not available here");
      await enableAutoRespond(operation.projectId, operation.conversationId, await bobAutoRespondConfig(settings, operation.engine), null, session.accountId);
      // A conversation that already waits is answered now, not at its next stop.
      void observeAutoResponder((await getAutoRespond(operation.projectId, operation.conversationId))!).catch((error) => console.warn("Auto respond did not start", error instanceof Error ? error.message : error));
      return `Auto respond is on for "${operation.title}". I'll answer its routine questions, and it stops for anything that needs you.`;
    }
    case "change-model": {
      await configureConversation(options, { ...(operation.agent ? { engine: operation.agent } : {}), ...(operation.modelId ? { provider: operation.provider ?? undefined, modelId: operation.modelId } : {}), ...(operation.effort ? { level: operation.effort } : {}) });
      return `Changed "${operation.title}". Its next turn uses it.`;
    }
    case "attach-secret": {
      await attachConversationSecretAsActor(operation.engine, operation.sessionId, operation.accountId);
      return `Attached "${operation.accountLabel}" to "${operation.title}".`;
    }
  }
}

async function runInProject(settings: BobSettings, operation: Exclude<Operation, { conversationId: string }>): Promise<string> {
  const project = await getProject(operation.projectId);
  if (!project) throw new Error("That project is no longer here");
  switch (operation.op) {
    case "pull-request": {
      const action = operation.action === "merge" ? { action: "merge" as const, number: operation.number, sha: operation.sha, method: "merge" as const }
        : operation.action === "approve" ? { action: "review" as const, number: operation.number, event: "APPROVE" as const, body: operation.body }
          : operation.action === "comment" ? { action: "comment" as const, number: operation.number, body: operation.body }
            : { action: operation.action, number: operation.number };
      await projectGithubAction(project.id, action);
      return `${{ merge: "Merged", close: "Closed", reopen: "Reopened", approve: "Approved", comment: "Commented on" }[operation.action]} #${operation.number} "${operation.title}".`;
    }
    case "add-task": {
      await assertProjectEditable(project);
      const engine = isHarnessId(settings.harnessId) ? settings.harnessId : "pi";
      const task = await createTask(project.id, project.path, operation.title, operation.description, operation.start ? "in_progress" : "backlog", engine, false, false, {});
      if (operation.start) startTaskRun(project, task).catch((error) => console.warn("Task start failed", error));
      broadcastToProject(project.id, { type: "tasksChanged" });
      return operation.start ? `Added "${task.title}" to the Tasks list of ${project.name} and started it.` : `Added "${task.title}" to the Tasks list of ${project.name}.`;
    }
    case "add-note": {
      createQuickNote({ projectId: project.id, title: operation.title, content: operation.content, harnessId: settings.harnessId || iconHarnessId() });
      return `Saved the quick note "${operation.title}" in ${project.name}. Start it from its Quick notes when you want.`;
    }
  }
}

registerBobAction("operate.run", async ({ db, session, action }) => {
  const { operation } = z.object({ operation: operationSchema }).parse(action.data);
  const settings = readBobSettings(db, session.accountId);
  // The person pressed the button, so the change is theirs: it runs as them, with their rights.
  const text = await runAsAccount(actingAccountFromSession(session), () => "conversationId" in operation ? runOnConversation(session, settings, operation) : runInProject(settings, operation));
  const project = await runAsAccount(actingAccountFromSession(session), () => getProject(operation.projectId));
  return [bobSays(db, session, text, { importance: "done", via: `Organize · ${operation.op.replace("-", " ")}`, projectId: operation.projectId, projectName: project?.name ?? null })];
});
