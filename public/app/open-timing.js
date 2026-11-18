import { api } from "./api.js";

/**
 * How long opening a conversation takes as the person sees it: from the click to the chat showing it is on its way
 * (`shown`), to the socket being asked for (`connecting`), and to the conversation's ready answer (`ready`). The node
 * counts the three in its performance log (client.conversation.*), so a change to this path is measured on real use.
 * One open is timed at a time: a newer click replaces it, and a reconnect is not an open.
 */
let current = null;

/** `source`: "card" (Home, the Inbox, the board) or "list" (a project's own list and the dialogs). */
export function startOpenTiming(source) {
  current = { startedAt: performance.now(), source, list: "listed", owner: "local", ids: [], shownMs: null, connectingMs: null };
}

/** Where the conversation's row came from ("listed", "card", "fetched"), whether another machine runs it ("local",
    "peer"), and `ids`, the session and conversation ids its ready answer may carry. */
export function noteOpenTiming(fields) {
  if (current) Object.assign(current, fields);
}

/** `step`: "shown" or "connecting"; only the first of each counts. */
export function markOpenStep(step) {
  if (!current) return;
  const key = `${step}Ms`;
  if (current[key] === null) current[key] = Math.round(performance.now() - current.startedAt);
}

/** At the ready answer. One for another conversation (a new one started meanwhile) drops the timing unreported. */
export function finishOpenTiming(ready) {
  if (!current) return;
  const done = current;
  current = null;
  if (!done.ids.some((id) => id && (id === ready?.sessionId || id === ready?.conversationId))) return;
  const readyMs = Math.round(performance.now() - done.startedAt);
  const body = {
    source: done.source, list: done.list, owner: done.owner,
    shownMs: done.shownMs ?? readyMs, connectingMs: done.connectingMs ?? readyMs, readyMs,
  };
  void api("/api/performance/conversation-open", { method: "POST", body: JSON.stringify(body) }).catch(() => undefined);
}
