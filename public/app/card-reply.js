import { api } from "./api.js";
import { confirmAction } from "./shell.js";

export async function sendCardReply(ref, message, dialog) {
  const send = (offlineOwnerNodeId) => api("/api/control-center/cards/reply", {
    method: "POST", body: JSON.stringify({ ...ref, message, offlineOwnerNodeId }),
  });
  try {
    await send();
  } catch (error) {
    const offer = error.details;
    if (error.status !== 409 || !offer?.offlineOwner) throw error;
    if (!dialog.open || !await confirmAction({
      title: "Take over this conversation and send your answer?",
      message: `${offer.offlineOwner.name} is offline. ${offer.takeoverNodeName} will continue from its last synced history, which may be older.`,
      confirmLabel: "Take over and send",
    }) || !dialog.open) return false;
    // The first request was refused before queueing anything. Only retry that specific refusal.
    await send(offer.offlineOwner.id);
  }
  return true;
}
