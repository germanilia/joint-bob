import { randomUUID } from "node:crypto";
import { runAsAccount } from "../account-context.js";
import { personalContinuationAllowed } from "../control-center/auto-respond.js";
import { STUCK_PREFIX } from "../control-center/review-check.js";
import { getAutoRespond } from "../conversation-auto-respond.js";
import { ownerAsActor, resourceOwner } from "../ownership.js";
import { queueConversationPrompt } from "./conversation-prompt.js";
import { announceStuckConversation } from "./control-center-watch.js";
import { findHarnessSession, harnessTurnBusy, ZOMBIE_TURN_GRACE_MS, type StoppedTurn } from "./harness-sessions.js";

// Bob keeps conversations from staying stuck. The watchdog (harness-sessions.ts) stops a turn that has had no input or output
// for 30 minutes, and the shell wrapper stops a command that printed nothing for 30 minutes. A stopped turn would then sit
// there; here Bob tells the conversation to go on, as the account it ran as, so on the same subscription pool.

/** How many times Bob restarts one conversation within the window before he leaves it to the person. */
export const STUCK_RESTARTS = 3;
export const STUCK_RESTART_WINDOW_MS = 6 * 60 * 60_000;
/** How long Bob waits for a stopped turn to let go: a turn that never does is released as a zombie after its grace. */
const LET_GO_MS = ZOMBIE_TURN_GRACE_MS + 5 * 60_000;

export const stuckContinuationPrompt = `${STUCK_PREFIX}: it had no input or output for 30 minutes and looked stuck. Inspect the transcript and the working tree, check for commands or processes it left hanging, continue the unfinished work, and do not repeat completed side effects.`;

const restarts = new Map<string, number[]>();
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Whether Bob may restart the conversation once more now, counting the restart when he may. */
export function takeStuckRestart(key: string, now = Date.now()): boolean {
  const recent = (restarts.get(key) ?? []).filter((at) => now - at < STUCK_RESTART_WINDOW_MS);
  const allowed = recent.length < STUCK_RESTARTS;
  restarts.set(key, allowed ? [...recent, now] : recent);
  return allowed;
}

/** How Bob tells a conversation to go on and tells the person; tests stand in for both. */
export interface StuckDeps {
  continueAs: (accountId: string | null, shared: StoppedTurn["shared"], message: string) => Promise<void>;
  announce: (projectId: string, conversationId: string, restarted: boolean) => Promise<void>;
}

const stuckDeps: StuckDeps = {
  continueAs: async (accountId, shared, message) => {
    const actor = ownerAsActor(accountId ?? resourceOwner("project", shared.projectId));
    await runAsAccount(actor, () => queueConversationPrompt({
      projectId: shared.projectId, engine: shared.engine, sessionId: shared.session.id, message, requestId: randomUUID(), label: "Bob", until: "started",
    }));
  },
  announce: announceStuckConversation,
};

/** Once the stopped turn has let go, tells the conversation to carry on, unless someone wrote to it or its responder will. */
export async function continueStuckTurn({ shared, accountId }: StoppedTurn, pollMs = 2_000, deps: StuckDeps = stuckDeps): Promise<void> {
  const deadline = Date.now() + LET_GO_MS;
  for (;;) {
    // Any input since the stop (the person, a schedule, a responder) clears it: the conversation is not left stuck.
    if (!shared.watchdogStopping) return;
    if (findHarnessSession(shared.projectId, shared.engine, shared.session.id) !== shared || !harnessTurnBusy(shared)) break;
    if (Date.now() > deadline) return;
    await pause(pollMs);
  }
  const { projectId, conversationId } = shared;
  if (!await personalContinuationAllowed(projectId, conversationId)) return;
  // Auto respond and system control push on by themselves, with the failed turn in front of the responder.
  if ((await getAutoRespond(projectId, conversationId))?.status === "active") return;
  if (!takeStuckRestart(`${projectId}\n${conversationId}`)) {
    await deps.announce(projectId, conversationId, false);
    return;
  }
  await deps.continueAs(accountId, shared, stuckContinuationPrompt);
  console.warn(`Restarted stuck ${shared.engine} conversation ${shared.session.id}`);
  await deps.announce(projectId, conversationId, true);
}
