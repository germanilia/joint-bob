import { state } from "./state.js";

// The last failed API calls, newest last. Request bodies and query strings are never kept: they hold
// message text, local paths and sometimes credentials.
const MAX_FAILURES = 20;
const failures = [];

export function recordFailure(failure) {
  failures.push({ at: new Date().toISOString(), ...failure });
  if (failures.length > MAX_FAILURES) failures.shift();
}

function describeState() {
  return {
    page: location.origin + location.pathname,
    version: document.querySelector("#workspaceVersion")?.textContent || null,
    userAgent: navigator.userAgent,
    online: navigator.onLine,
    activeProjectId: state.activeProjectId,
    activeSessionId: state.activeSessionId,
    activeSessionPath: state.activeSessionPath,
    activeNodeId: state.activeNodeId,
    conversationNodeName: state.conversationNodeName,
    conversationReadOnly: state.conversationReadOnly,
    conversationReadOnlyReason: state.conversationReadOnlyReason,
    conversationLock: state.conversationLock,
    sessionNodes: state.sessionNodes.map(({ id, name, local, mapped, online }) => ({ id, name, local, mapped, online })),
  };
}

export function buildErrorReport(message) {
  return JSON.stringify({ reportedAt: new Date().toISOString(), message, state: describeState(), recentFailedRequests: failures }, null, 2);
}

export async function copyErrorReport(message) {
  await navigator.clipboard.writeText(buildErrorReport(message));
}

export function downloadErrorReport(message) {
  const url = URL.createObjectURL(new Blob([buildErrorReport(message)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `joint-bob-error-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
