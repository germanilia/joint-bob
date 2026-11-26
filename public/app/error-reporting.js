// Sends bounded browser diagnostics to this node; external delivery is the node admin's choice.
import { recentFailedRequestMetadata } from "./error-report.js";
import { state } from "./state.js";

const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 10;
const recent = new Map();
let windowStartedAt = 0;
let sentInWindow = 0;

function admit(message, now) {
  if (now - windowStartedAt >= WINDOW_MS) { windowStartedAt = now; sentInWindow = 0; }
  for (const [key, at] of recent) if (now - at >= WINDOW_MS) recent.delete(key);
  const key = message.split("\n")[0].slice(0, 300);
  if (recent.has(key) || sentInWindow >= MAX_PER_WINDOW) return false;
  recent.set(key, now);
  sentInWindow += 1;
  return true;
}

export async function reportClientError(kind, message) {
  if (!state.authenticated || !state.csrfToken || !message || !admit(message, Date.now())) return null;
  // Plain fetch: a failed diagnostic must not sign out the user or report itself.
  try {
    const response = await fetch("/api/client-errors", {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
      headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrfToken },
      body: JSON.stringify({ kind, message: message.slice(0, 64_000), page: location.pathname.slice(0, 500), failedRequests: recentFailedRequestMetadata() }),
    });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

