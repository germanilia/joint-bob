import type { AuthSession } from "../auth.js";
import { bobDatabase, readBobSettings } from "../control-center/bob-store.js";
import { otherPersonsMachine } from "../control-center/clusters-data.js";
import { systemMessages, type SystemMessage } from "../control-center/system-messages.js";
import { productionGuard } from "../guardian/settings.js";
import { peerAway } from "../peer-presence.js";
import { collectSubscriptionDetections } from "../subscription-detection.js";
import { projectsWithSharedNames } from "./projects.js";
import { bobDecisionModel } from "./bob.js";
import { loadBoard } from "./control-center-board.js";
import { listRuntimePeers } from "./runtime-peers.js";

/**
 * What is wrong with this installation, found now: the messages the control center's list shows first. Each is read from
 * the same facts the rest of the app acts on (the keys projects have attached, Guardian's settings, Claude's own sign-in
 * status, which machines answer), so a message is there exactly while its cause is.
 */
export async function loadSystemMessages(session: AuthSession): Promise<SystemMessage[]> {
  const [projects, db, detections, peers, theirs, { cards }] = await Promise.all([
    projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }),
    bobDatabase(),
    collectSubscriptionDetections(),
    listRuntimePeers(),
    otherPersonsMachine(),
    loadBoard(session),
  ]);
  const settings = readBobSettings(db, session.accountId);
  const claude = detections.find((detection) => detection.harnessId === "claude");
  return systemMessages({
    classifier: settings.classifier,
    decisionModelReady: Boolean(await bobDecisionModel(projects, settings)),
    guardian: await productionGuard(),
    claudeSignedOut: claude?.status === "unavailable" && claude.message.startsWith("Claude is not signed in"),
    machinesAway: peers.filter((peer) => !theirs(peer.id) && peerAway(peer.id))
      .map((peer) => ({ id: peer.id, name: peer.name, conversations: cards.filter((card) => card.executionNodeId === peer.id).length })),
  });
}
