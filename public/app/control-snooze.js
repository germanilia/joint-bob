// Snooze: a Needs you card put aside for now. It leaves Needs you and the "waiting for you" counts, and comes back when its time
// comes or something new happens in it (src/control-center/snoozes.ts). The board, Home and the needs sheet offer it.
import { api } from "./api.js";
import { registerCardAction, registerCardDecorator } from "./control-cards.js";
import { openRowMenu } from "./row-menu.js";
import { toast } from "./shell.js";

const HOUR_MS = 60 * 60 * 1_000;
const MORNING_HOUR = 8;

/** Tomorrow at 8, the person's own time. */
function tomorrowMorning(now = new Date()) {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(MORNING_HOUR, 0, 0, 0);
  return at;
}

async function send(card, action, until = null) {
  await api("/api/control-center/snooze", { method: "POST", body: JSON.stringify({ projectId: card.projectId, conversationId: card.conversationId, action, until }) });
  // The board, Home and the badge all redraw on this.
  window.dispatchEvent(new CustomEvent("control-center-changed"));
}

/** The three choices, in the shared menu under the button pressed; `onSnoozed` runs once one is saved. */
export function chooseSnooze(card, anchor, onSnoozed = () => {}) {
  const pick = (until, word) => () => send(card, "snooze", until).then(() => { toast(`Snoozed ${word}`); onSnoozed(); }).catch((error) => toast.error(error.message));
  openRowMenu(anchor, [
    { label: "For 1 hour", icon: "clock", testid: "snooze-hour", onSelect: pick(new Date(Date.now() + HOUR_MS).toISOString(), "for an hour") },
    { label: "Until tomorrow morning", icon: "clock", testid: "snooze-morning", onSelect: pick(tomorrowMorning().toISOString(), "until tomorrow morning") },
    { label: "Until something changes", icon: "archive", testid: "snooze-change", title: "It comes back when the agent writes again or asks something new", onSelect: pick(null, "until something changes") },
  ]);
}

export const wakeCard = (card) => send(card, "wake");

/** "until 14:00", "until tomorrow 08:00", or "until something changes". */
export function snoozedWords(snoozed) {
  if (!snoozed.until) return "Snoozed until something changes";
  const until = new Date(snoozed.until);
  const time = until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const day = until.toDateString() === today.toDateString() ? "" : until.toDateString() === tomorrow.toDateString() ? "tomorrow " : `${until.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} `;
  return `Snoozed until ${day}${time}`;
}

registerCardAction({
  id: "snooze", label: "Snooze", order: 60, title: "Put it aside for now: it leaves Needs you until the time you choose or something new happens",
  visible: (card) => card.column === "needs-you",
  // The button pressed keeps focus while its click runs, so the menu opens under it.
  run: (card) => chooseSnooze(card, document.activeElement),
});

registerCardAction({
  id: "wake", label: "Wake", style: "primary", order: 1, title: "Bring it back to Needs you now",
  visible: (card) => card.column === "snoozed", run: wakeCard,
});

registerCardDecorator((root, card) => {
  if (!card.snooze) return;
  const line = document.createElement("p");
  line.className = "control-card-snoozed";
  line.dataset.testid = "control-card-snoozed";
  line.textContent = snoozedWords(card.snooze);
  root.append(line);
});
