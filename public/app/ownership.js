import { api, savePreferencesInBackground } from "./api.js";
import { reconcileTranscriptConflict } from "./transcript-conflict.js";
import { renderConversationLock } from "./chat-controls.js";
import { elements } from "./elements.js";
import { currentMobileView, shortSessionTitle } from "./layout.js";
import { confirmAction, toast } from "./shell.js";
import { openSession } from "./socket.js";
import { shared, state, TAKE_OWNERSHIP_WAIT_SECONDS } from "./state.js";
import { activeChatSession } from "./terminal.js";
import "./takeback-notice.js";

function resetOwnershipWait() {
  if (shared.ownershipWait) shared.ownershipWait.resolve(false);
  shared.ownershipWait = null;
  shared.ownershipTaking = false;
  elements.conversationLockStatus.textContent = "";
  renderConversationLock();
}

// This page cannot read another node's file sync status, so a takeover that continues
// there counts a grace period down before fencing the owner.
function countdownOwnershipWait(report) {
  if (shared.ownershipWait) return shared.ownershipWait.promise;
  let seconds = TAKE_OWNERSHIP_WAIT_SECONDS;
  report(`Waiting ${seconds}s for files to finish…`);
  const wait = { promise: null, resolve: null, settled: false };
  const promise = new Promise((resolve) => {
    const finish = (value) => {
      if (wait.settled) return;
      wait.settled = true;
      clearInterval(interval);
      resolve(value);
    };
    const interval = setInterval(() => {
      seconds -= 1;
      report(seconds ? `Waiting ${seconds}s for files to finish…` : "Wait finished.");
      if (!seconds) finish(true);
    }, 1000);
    wait.resolve = finish;
  });
  wait.promise = promise;
  shared.ownershipWait = wait;
  return promise;
}

// Longer than this, the takeover goes on with the files already here, as it does when the owner is offline.
const PROJECT_FILES_WAIT_MS = 120_000;

function formatOwnershipBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

// Wait only for this conversation's working folder, not the project's other worktrees.
// Errors and missing folders keep their existing project-level handling.
function waitForConversationFiles(projectId, destination, worktreeId, report) {
  if (shared.ownershipWait) return shared.ownershipWait.promise;
  const started = Date.now();
  const wait = { promise: null, resolve: null, settled: false };
  let timer = null;
  const query = new URLSearchParams(worktreeId ? { worktreeId } : {});
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/sync/status${query.size ? `?${query}` : ""}`;
  wait.promise = new Promise((resolve, reject) => {
    const finish = (value) => {
      if (wait.settled) return;
      wait.settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    wait.resolve = finish;
    const check = async () => {
      let status;
      try { status = (await api(endpoint)).syncStatus; }
      catch (error) {
        if (!wait.settled) { wait.settled = true; reject(error); }
        return;
      }
      if (wait.settled) return;
      if (status.state !== "syncing" || Date.now() - started > PROJECT_FILES_WAIT_MS) { finish(true); return; }
      const files = status.remainingFiles;
      report(files ? `Copying files to ${destination.name}: ${files} ${files === 1 ? "file" : "files"}, ${formatOwnershipBytes(status.remainingBytes)} left…` : `${status.message || "Checking files"}…`);
      timer = setTimeout(check, 1000);
    };
    report("Checking files…");
    void check();
  });
  shared.ownershipWait = wait;
  return wait.promise;
}

function waitForLockOwnershipSync(projectId, destination, worktreeId) {
  elements.conversationLockTakeButton.textContent = "Cancel transfer";
  elements.conversationLockTakeButton.disabled = false;
  const report = (text) => { elements.conversationLockStatus.textContent = text; };
  const engine = state.projects.find((project) => project.id === projectId)?.syncStatus?.engine;
  // A project shared with no other machine has no files on their way.
  if (!engine || engine === "none") return Promise.resolve(true);
  // The status this page can read is this node's; for another destination only the grace period is left.
  return destination.local ? waitForConversationFiles(projectId, destination, worktreeId, report) : countdownOwnershipWait(report);
}

let takeoverController = null;

// Takeover continues the conversation on this node's own filesystem: the
// transcript and the project's files are expected here already, and only the
// write lock moves.
async function takeLockedConversationOwnership(force = false, takeBackHere = false) {
  const session = activeChatSession();
  if (shared.ownershipWait || shared.ownershipTaking || !state.activeProjectId || !state.activeSessionPath) return;
  if (!session && !takeBackHere) return;
  const projectId = state.activeProjectId;
  const sessionPath = state.activeSessionPath;
  const sessionId = session?.id || state.activeSessionId;
  const title = session ? shortSessionTitle(session) : elements.sessionTitle.textContent;
  const owner = state.conversationLock || { nodeName: state.conversationNodeName };
  const destination = state.sessionNodes.find((node) => takeBackHere ? node.local : node.id === state.activeNodeId);
  if (!destination?.mapped) throw new Error("Map project first on this node");
  if (force && !await confirmAction({
    title: `Force ownership transfer to ${destination.name}?`,
    message: "If reachable, the controlling node and its twins get 30 seconds to decline. Otherwise, the transfer can stop reachable runs and continue from this node's synced history, which may be older. Existing histories are kept in backups. An unreachable node may keep running.",
    confirmLabel: "Force ownership transfer", destructive: true,
  })) return;
  if (state.activeProjectId !== projectId || state.activeSessionPath !== sessionPath) return;
  const proceed = force || await waitForLockOwnershipSync(projectId, destination, session.worktree?.id);
  if (!proceed) { resetOwnershipWait(); return; }
  shared.ownershipTaking = true;
  elements.conversationLockStatus.textContent = "Taking ownership…";
  const transfer = async (historyOwnerNodeId) => {
    takeoverController = new AbortController();
    shared.ownershipTaking = true;
    renderConversationLock();
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions/take-ownership`, {
      method: "POST", body: JSON.stringify({ peerId: destination.id, sessionId: sessionId || undefined, sessionPath: session?.path || sessionPath, sessionName: title.slice(0, 120), ...(force ? { force: true } : {}), ...(historyOwnerNodeId ? { historyOwnerNodeId } : {}) }),
      signal: takeoverController.signal,
    });
    if (state.activeProjectId === projectId && state.activeSessionPath === sessionPath) {
      state.activeNodeId = destination.id;
      state.activeSessionId = null;
      if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: destination.id, activeSessionId: null });
      resetOwnershipWait();
      openSession(result.sessionPath, title, false, null, currentMobileView() === "control");
    }
    toast(force ? `Ownership forced using ${destination.name}'s history. Backup: ${result.saved}.${result.pendingPeerIds.length ? " Some machines could not confirm stopping; they will receive ownership when they reconnect." : " Reachable runs stopped."}` : result.saved ? `Ownership taken using ${owner.nodeName}'s history. Backup: ${result.saved}` : result.pendingPeerIds?.length ? "Ownership taken; offline nodes will update when they return" : "Ownership taken", result.saved ? 12000 : 8000);
  };
  try { await transfer(); }
  catch (error) {
    resetOwnershipWait();
    if (error.cancelled) { toast("Cancellation requested. Reopen the conversation to check which machine owns it; the transfer may already have completed.", 12000); return; }
    if (force || !await reconcileTranscriptConflict(error, { projectId, engine: session.harnessId, sessionId,
      transfer: { ownerName: owner.nodeName, destinationName: destination.name, accept: () => transfer(owner.nodeId) },
    })) throw error;
  } finally { takeoverController = null; resetOwnershipWait(); }
}

elements.conversationTakeBackButton.addEventListener("click", () => {
  void takeLockedConversationOwnership(true, true).catch((error) => { resetOwnershipWait(); toast.error(error.message); });
});

elements.conversationLockForceButton.addEventListener("click", () => {
  void takeLockedConversationOwnership(true).catch((error) => { resetOwnershipWait(); toast.error(error.message); });
});

elements.conversationLockTakeButton.addEventListener("click", () => {
  if (shared.ownershipWait && !shared.ownershipTaking) { shared.ownershipWait.resolve(false); return; }
  if (takeoverController) { takeoverController.abort(); return; }
  void takeLockedConversationOwnership().catch((error) => { resetOwnershipWait(); toast.error(error.message); });
});
