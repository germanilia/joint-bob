import { showSignedOut } from "./auth.js";
import { elements } from "./elements.js";
import { renderProjects } from "./project-list.js";
import { renderRecentSessionsDialog } from "./recents.js";
import { renderSessions } from "./session-list.js";
import { recordFailure } from "./error-report.js";
import { state } from "./state.js";

function headers() {
  return state.csrfToken ? { "X-CSRF-Token": state.csrfToken, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

function requestFailure(error, path, options, status) {
  const cause = error instanceof Error ? error : new Error(String(error));
  const method = (options.method || "GET").toUpperCase();
  // Query strings contain search text, local paths and sometimes credentials.
  const requestPath = path.split(/[?#]/)[0];
  const cancelled = cause.name === "AbortError" && Boolean(options.signal?.aborted) && options.signal.reason?.name === "AbortError" && status < 400;
  const timedOut = cause.name === "TimeoutError" || (cause.name === "AbortError" && options.signal?.reason?.name === "TimeoutError") || status === 408 || status === 504;
  const interrupted = cause.name === "AbortError" || cause.message === "This operation was aborted";
  let reason = cause.message;
  if (cancelled) reason = "The request was cancelled.";
  else if (timedOut) reason = "The request timed out.";
  else if (interrupted) reason = "The request was interrupted before completion. No reason was provided.";
  else if (status === 0 && cause.name === "TypeError") reason = "No response was received. Check your connection.";
  else if (cause.name === "SyntaxError") reason = "The server returned an unreadable response.";
  const uncertainWrite = !["GET", "HEAD"].includes(method) && (interrupted || timedOut || status < 400);
  const message = `Could not complete ${method} ${requestPath}: ${reason}${uncertainWrite ? " Check whether the change took effect before trying again." : ""}`;
  const failure = Object.assign(new Error(message, { cause }), {
    name: cause.name, method, path: requestPath, status, details: cause.details, cancelled,
  });
  // Most callers catch and toast only the message, so record diagnostics here.
  // Never log request headers, bodies or query values.
  if (!cancelled) {
    recordFailure({ method, path: requestPath, status, name: cause.name, message: cause.message, reason, details: cause.details, cancelled, uncertainWrite });
    console.warn("API request failed", { method, path: requestPath, status, name: cause.name, message: reason });
    window.dispatchEvent(new CustomEvent("joint-bob-client-error", { detail: { kind: "toast", message } }));
  }
  return failure;
}

// A read that got no answer at all (a laptop waking, a changed network) is asked again before anyone
// hears of it. Writes are never repeated: they may have reached the server.
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

async function fetchWithRetry(path, init) {
  const read = ["GET", "HEAD"].includes((init.method || "GET").toUpperCase());
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(path, init);
    } catch (error) {
      if (!read || error.name !== "TypeError" || init.signal?.aborted || attempt === RETRY_DELAYS_MS.length) throw error;
      // A cancellation during the wait ends it; the next fetch then rejects with the caller's reason.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, RETRY_DELAYS_MS[attempt]);
        init.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
}

async function send(path, options, consume) {
  let status = 0;
  try {
    const response = await fetchWithRetry(path, { ...options, cache: "no-store", headers: { ...headers(), ...(options.headers || {}) } });
    status = response.status;
    if (!response.ok) {
      if (status === 401 && !["/api/auth/status", "/api/auth/login", "/api/auth/login/mfa"].includes(path)) showSignedOut();
      const body = await response.json().catch((error) => {
        if (error.name !== "SyntaxError") throw error;
        return { error: response.statusText || `HTTP ${status}` };
      });
      throw Object.assign(new Error(body.error || response.statusText || `HTTP ${status}`), { details: body.details });
    }
    // Reading a JSON, file or streamed body can fail after fetch has succeeded.
    return await consume(response);
  } catch (error) {
    throw requestFailure(error, path, options, status);
  }
}

export async function api(path, options = {}) {
  return send(path, options, (response) => response.status === 204 ? null : response.json());
}

/** For a route that replies with a file, such as audio. */
export async function apiBlob(path, options = {}) {
  return send(path, options, (response) => response.blob());
}

const NDJSON = "application/x-ndjson";

/** Calls a route that streams JSON lines, handing each line to onLine. A plain JSON reply arrives as one "done" line. */
export async function apiLines(path, options, onLine) {
  return send(path, { ...options, headers: { Accept: `${NDJSON}, application/json`, ...(options.headers || {}) } }, async (response) => {
    if (!response.headers.get("content-type")?.startsWith(NDJSON)) { onLine({ type: "done", ...await response.json() }); return; }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      buffer += chunk.value;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) onLine(JSON.parse(line));
    }
    if (buffer.trim()) onLine(JSON.parse(buffer));
  });
}

export async function savePreferences(partial) {
  return api("/api/preferences", { method: "PUT", body: JSON.stringify(partial) });
}

let pinsReadVersion = 0;
let confirmedPins;
let pinWrites = Promise.resolve();
const pendingPins = new Map();
let pinsAuthToken;

function pinScope() {
  if (pinsAuthToken !== state.csrfToken) {
    pinsAuthToken = state.csrfToken;
    confirmedPins = undefined;
    pendingPins.clear();
    ++pinsReadVersion;
  }
  return pinsAuthToken;
}

function renderPins() {
  state.replicatedPinnedProjectIds = [...confirmedPins.projectIds];
  state.pinnedConversations = [...confirmedPins.conversations];
  for (const change of pendingPins.values()) {
    if (change.kind === "project") {
      state.replicatedPinnedProjectIds = state.replicatedPinnedProjectIds.filter((id) => id !== change.projectId);
      if (change.pinned) state.replicatedPinnedProjectIds.push(change.projectId);
    } else {
      state.pinnedConversations = state.pinnedConversations.filter((pin) => !(pin.projectId === change.projectId && pin.engine === change.engine && pin.sessionId === change.sessionId));
      if (change.pinned) state.pinnedConversations.push({ projectId: change.projectId, engine: change.engine, sessionId: change.sessionId });
    }
  }
  renderProjects();
  renderSessions();
  if (elements.recentSessionsDialog.open) renderRecentSessionsDialog();
  window.dispatchEvent(new Event("conversation-pins-changed"));
}

export async function loadPins() {
  const token = pinScope();
  const version = ++pinsReadVersion;
  const pins = await api("/api/pins");
  if (version !== pinsReadVersion || token !== state.csrfToken) return;
  confirmedPins = pins;
  renderPins();
}

/** Preserve click order on the wire and overlay unacknowledged intent on snapshots. */
export function savePin(target, pinned) {
  const token = pinScope();
  confirmedPins ??= { projectIds: [...state.replicatedPinnedProjectIds], conversations: [...state.pinnedConversations] };
  const key = JSON.stringify([target.kind, target.projectId, target.engine, target.sessionId]);
  const change = { ...target, pinned };
  pendingPins.set(key, change);
  ++pinsReadVersion;
  renderPins();
  const write = pinWrites.then(() => {
    if (token !== state.csrfToken) throw new Error("Sign-in changed before pin could be saved");
    return api("/api/pins", { method: "PUT", body: JSON.stringify(change) });
  });
  pinWrites = write.catch(() => {});
  return write.then((pins) => { if (token === state.csrfToken) confirmedPins = pins; }).finally(() => {
    if (token !== state.csrfToken) return;
    ++pinsReadVersion;
    if (pendingPins.get(key) === change) pendingPins.delete(key);
    renderPins();
    // Also reconcile uncertain failures; never retry a mutation automatically.
    void loadPins().catch((error) => console.warn("Could not reconcile pins", error));
  });
}

export function savePreferencesInBackground(partial) {
  void savePreferences(partial).catch((error) => console.warn("Could not save preferences", error));
}
