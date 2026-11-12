// Bob's review check, shown under the answer it judged: the verdict, why, and how it was decided (the agent's
// BOB_GOAL_BLOCKED line, the decision model with its confidence and the threshold, or Bob's agent and its model after
// the decision model was not sure). When Bob passed over the turn without judging it, the note says why instead.
// Data: GET /api/control-center/bob/review-check; read again when the transcript renders and on controlCenterChanged.

import { api } from "./api.js";
import { elements } from "./elements.js";
import { state } from "./state.js";

const VERDICTS = { done: "done · ready for review", continue: "not done, told to go on", "needs-user": "needs you" };

let generation = 0;

/** The newest answer in the transcript and when it was written. */
function lastAnswer() {
  const answers = elements.messages.querySelectorAll(".message.assistant");
  const bubble = answers[answers.length - 1];
  const at = Date.parse(bubble?.querySelector(".message-time")?.dateTime ?? "");
  return bubble && Number.isFinite(at) ? { bubble, at } : null;
}

function line(label, text) {
  const row = document.createElement("div");
  const name = document.createElement("b");
  name.textContent = `${label}: `;
  row.append(name, document.createTextNode(text));
  return row;
}

function noteFor({ check, skipped }, answeredAt) {
  const checkedThisAnswer = check && Date.parse(check.checkedAt) >= answeredAt;
  const skippedThisAnswer = skipped && Date.parse(skipped.at) >= answeredAt && (!checkedThisAnswer || Date.parse(skipped.at) > Date.parse(check.checkedAt));
  if (!checkedThisAnswer && !skippedThisAnswer) return null;
  const note = document.createElement("details");
  note.className = "review-check-note";
  note.dataset.testid = "review-check-note";
  note.style.cssText = "margin-top:6px;font-size:12px;opacity:.8";
  const summary = document.createElement("summary");
  summary.style.cursor = "pointer";
  if (skippedThisAnswer) {
    summary.textContent = "Bob did not check this answer";
    note.append(summary, line("Why", skipped.reason), line("At", new Date(skipped.at).toLocaleString()));
  } else {
    summary.textContent = `Bob's check: ${VERDICTS[check.verdict] ?? check.verdict}`;
    note.append(summary, line("Why", check.reason || "no reason given"), line("Decided by", check.by), line("At", new Date(check.checkedAt).toLocaleString()));
    if (check.pushes) note.append(line("Pushes in a row", String(check.pushes)));
  }
  return note;
}

/** Reads Bob's check of the open conversation and shows it under its newest answer. */
export async function refreshReviewCheckNote() {
  const projectId = state.activeConversationProjectId ?? state.activeProjectId;
  const conversationId = state.activeConversationId;
  const mine = ++generation;
  elements.messages.querySelectorAll(".review-check-note").forEach((node) => node.remove());
  if (!projectId || !conversationId) return;
  const query = new URLSearchParams({ projectId, conversationId });
  const result = await api(`/api/control-center/bob/review-check?${query}`).catch((error) => {
    console.warn("Could not read Bob's review check", error);
    return null;
  });
  // Another conversation opened, or a newer read started, while this one was on its way.
  if (!result || mine !== generation || state.activeConversationId !== conversationId) return;
  const answer = lastAnswer();
  const note = answer && noteFor(result, answer.at);
  if (note) answer.bubble.append(note);
}

document.addEventListener("chat-transcript-rendered", () => { void refreshReviewCheckNote(); });
window.addEventListener("control-center-changed", () => { void refreshReviewCheckNote(); });
