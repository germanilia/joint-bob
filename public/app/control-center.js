import { api, savePreferencesInBackground } from "./api.js";
import { elements } from "./elements.js";
import { selectProject } from "./project-selection.js";
import { openListedSession } from "./reviews.js";
import { formatDate, toast } from "./shell.js";
import { state } from "./state.js";
import { registerControlView } from "./control-views.js";
import { chooseConversationFeedback } from "./conversation-feedback.js";
import { boardTools, briefStatus, cardActionList, decorateCard, projectActionList, registerBoardTool, registerCardAction } from "./control-cards.js";
import { openQuickNote } from "./quick-notes.js";
import { glide, positions, vanish } from "./control-vanish.js";
import { PROJECT_COLORS } from "./session-rows.js";

const DEFAULT_COLOR = "#3a3f46";
const COLUMNS = [
  { id: "needs-you", title: "Needs you", hint: "A step waiting for your OK, or an agent that stopped for you" },
  { id: "running", title: "Running", hint: "Where each one stands; hover a card for its summary" },
  { id: "review", title: "Done · ready for review", hint: "" },
  { id: "snoozed", title: "Snoozed", hint: "Put aside for now; each comes back when its time comes or something new happens" },
];

let board = { cards: [], projects: [] };
let refreshing = null;
let refreshAgain = false;

let saveTimer = null;

// Colors and the filter belong to the account, so they follow the person to every browser.
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => savePreferencesInBackground({ controlCenter: state.controlCenter }), 400);
}

const cardKey = (card) => `${card.projectId}:${card.conversationId}`;

/**
 * The palette a project without a color of its own is given a color from; slate is left for what belongs to no project.
 * Read when used: the color list's module imports back into this one, so it is not ready while this one loads.
 */
const palette = () => PROJECT_COLORS.filter((color) => color !== "slate");

/** A steady start in the palette from a project's id (FNV-1a, so like ids get unlike colors). */
function paletteStart(projectId) {
  let hash = 0x811c9dc5;
  for (const character of projectId) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return (hash >>> 0) % palette().length;
}

/**
 * Each project's color, worked out once per set of projects: the one chosen in its settings, as its project list shows it;
 * the others, in id order, take the first color from their steady start that no other project has, so no two share one
 * until the palette runs out.
 */
let colorsOf = { key: "", colors: new Map() };
function projectColors() {
  const key = JSON.stringify(board.projects.map((project) => [project.id, project.color ?? null]));
  if (key === colorsOf.key) return colorsOf.colors;
  const colors = new Map(board.projects.filter((project) => project.color).map((project) => [project.id, project.color]));
  const taken = new Set(colors.values());
  for (const project of [...board.projects].filter((candidate) => !candidate.color).sort((left, right) => left.id.localeCompare(right.id))) {
    const choices = palette();
    const start = paletteStart(project.id);
    const free = choices.map((_, step) => choices[(start + step) % choices.length]).find((color) => !taken.has(color));
    const color = free ?? choices[start];
    colors.set(project.id, color);
    taken.add(color);
  }
  colorsOf = { key, colors };
  return colors;
}

/** A project's color, on the board and in Bob's chat. One the board does not list yet keeps its steady start. */
export function projectColor(projectId) {
  return projectColors().get(projectId) ?? palette()[paletteStart(projectId)];
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function visibleCards() {
  const filter = new Set(state.controlCenter.filter);
  return board.cards.filter((card) => !filter.size || filter.has(card.projectId));
}

function renderFilters() {
  const chips = elements.controlCenterFilters;
  chips.replaceChildren();
  const all = element("button", "control-chip", "All");
  all.type = "button";
  all.classList.toggle("active", !state.controlCenter.filter.length);
  all.addEventListener("click", () => { state.controlCenter.filter = []; save(); render(); });
  chips.append(all);
  const withCards = new Set(board.cards.map((card) => card.projectId));
  for (const project of board.projects.filter((item) => withCards.has(item.id) || state.controlCenter.filter.includes(item.id))) {
    const chip = element("button", "control-chip project", project.name);
    chip.type = "button";
    chip.dataset.color = projectColor(project.id);
    chip.classList.toggle("active", state.controlCenter.filter.includes(project.id));
    chip.addEventListener("click", () => {
      state.controlCenter.filter = state.controlCenter.filter.includes(project.id) ? state.controlCenter.filter.filter((id) => id !== project.id) : [...state.controlCenter.filter, project.id];
      save();
      render();
    });
    chips.append(chip);
  }
}

function renderCard(card) {
  const root = element("article", "control-card");
  root.dataset.testid = "control-center-card";
  root.dataset.key = cardKey(card);
  root.dataset.column = card.column;
  const color = state.controlCenter.colors[cardKey(card)];
  if (color) {
    root.style.setProperty("--card-color", color);
    root.classList.add("colored");
  }

  const top = element("div", "control-card-top");
  const picker = element("input", "control-color");
  picker.type = "color";
  picker.value = color ?? DEFAULT_COLOR;
  picker.title = "Pick a color for this card";
  picker.dataset.testid = "control-center-color";
  picker.addEventListener("click", (event) => event.stopPropagation());
  picker.addEventListener("input", () => {
    state.controlCenter.colors[cardKey(card)] = picker.value;
    root.style.setProperty("--card-color", picker.value);
    root.classList.add("colored");
    save();
  });
  root.dataset.color = projectColor(card.projectId);
  top.append(avatarOf(card));
  const driver = driverOf(card);
  root.dataset.driver = driver?.id ?? "you";
  if (driver) {
    // The card's top row has room for the icon only; the words stay for readers and on hover.
    const [glyph, ...words] = driver.label.split(" ");
    const ribbon = element("span", `control-driver ${driver.id}`, `${glyph} `);
    ribbon.append(element("span", "control-word", words.join(" ")));
    ribbon.title = `${words.join(" ")}: ${driver.title}`;
    ribbon.dataset.testid = "control-card-driver";
    top.append(ribbon);
  }
  if (card.column === "running") top.append(runningBadge(card));
  if (card.column === "review") top.append(element("span", "control-badge review", "To review"));
  top.append(element("span", "control-spacer"));
  // Every card can be closed; its row of buttons has no room left, so Done sits up here.
  top.append(doneButton(card), picker);

  // A step waiting for the person takes the status's place, so every card keeps the same size.
  const body = element("div", "control-card-body");
  if (card.pendingReviews?.length || card.autoRespondStop) body.append(renderNeed(card));
  else {
    body.append(renderLive(card));
    if (card.column === "running") body.append(energyBar(card));
    const checked = checkLine(card);
    if (checked) body.append(checked);
  }

  const meta = [card.agentLabel, card.agentModel, card.backgroundRunning && !card.turnRunning ? "background tasks" : null, card.updatedAt ? formatDate(card.updatedAt) : null].filter(Boolean).join(" · ");
  const title = element("h3", "control-title", card.title);
  const metaLine = element("div", "control-meta", meta);
  metaLine.title = meta;
  root.append(top, title, body, metaLine);
  const buttons = cardActionList(card);
  if (buttons.length) {
    const row = element("div", "control-card-actions");
    for (const action of buttons) {
      const button = element("button", "control-card-action", action.label);
      // Not a class: the app's own `.primary` buttons are taller than a card's row.
      if (action.style) button.dataset.style = action.style;
      button.type = "button";
      button.title = action.title;
      button.dataset.testid = `control-card-action-${action.id}`;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        Promise.resolve(action.run(card)).catch((error) => toast.error(error.message));
      });
      row.append(button);
    }
    root.append(row);
  }
  decorateCard(root, card);
  // A card that waits for the person opens with them in control, ready to answer; any other opens to watch.
  root.addEventListener("click", () => {
    const take = card.column === "needs-you" ? cardActionList(card).find((action) => action.id === "take-control") : null;
    Promise.resolve(take ? take.run(card) : openCard(card)).catch((error) => toast.error(error.message));
  });
  return root;
}

/* ---------- the game on the board: avatars, energy, steps, the scoreboard, a cheer when one finishes ---------- */

/** Each card's agent as a character: its first letter in its project's color; it bobs while it works and waves when it waits. */
function avatarOf(card) {
  const avatar = element("span", `control-avatar ${card.column}`, (card.agentLabel || card.harnessId || "?").trim()[0].toUpperCase());
  avatar.dataset.testid = "control-card-avatar";
  avatar.title = [card.agentLabel, card.agentModel].filter(Boolean).join(" · ");
  if (card.column === "needs-you") avatar.append(element("i", "control-avatar-call", "!"));
  return avatar;
}

/** What each running card did since this page opened: a new activity line is one more step. */
const progress = new Map();
function countSteps(cards) {
  for (const card of cards) {
    const known = progress.get(cardKey(card));
    if (!known) progress.set(cardKey(card), { activity: card.activity, steps: card.activity ? 1 : 0 });
    else if (card.activity && card.activity !== known.activity) progress.set(cardKey(card), { activity: card.activity, steps: known.steps + 1 });
  }
}

/** A charging bar while its agent works, with the steps it took while you watched. */
function energyBar(card) {
  const bar = element("div", "control-energy");
  bar.dataset.testid = "control-card-energy";
  const steps = progress.get(cardKey(card))?.steps ?? 0;
  const fill = element("span", "control-energy-fill");
  fill.style.animationDelay = `-${Date.now() % 2_400}ms`;
  const track = element("span", "control-energy-track");
  track.append(fill);
  const count = element("span", "control-energy-steps", `${steps} step${steps === 1 ? "" : "s"}`);
  count.title = "Steps its agent took while you watched this page";
  bar.append(track, count);
  return bar;
}

/** Conversations that finished while this page was open: they cheered on their way to review. */
let finishedWhileWatching = 0;
/** Keys of cards that just went from running to review, so their next drawing cheers. */
const cheering = new Set();
function noteFinished(previous, next) {
  const before = new Map(previous.map((card) => [cardKey(card), card.column]));
  for (const card of next) {
    if (before.get(cardKey(card)) === "running" && card.column === "review") { cheering.add(cardKey(card)); finishedWhileWatching += 1; }
  }
}
function cheer(container) {
  for (const key of cheering) {
    const card = container.querySelector(`.control-card[data-key="${CSS.escape(key)}"]`);
    if (!card) continue;
    card.classList.add("control-card-cheer");
    const burst = element("span", "control-burst");
    burst.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 12; index += 1) {
      const bit = element("i");
      bit.style.setProperty("--turn", `${index * 30}deg`);
      burst.append(bit);
    }
    burst.append(element("b", "", "+1 done"));
    card.append(burst);
    setTimeout(() => { burst.remove(); card.classList.remove("control-card-cheer"); }, 1_800);
  }
  cheering.clear();
}

const isFolded = (id) => state.controlCenter.collapsed.includes(id);
/** Folds a section into its button, or opens it again; remembered with the account. Bob's page folds the chat and the column. */
export function toggleFolded(id) {
  state.controlCenter.collapsed = isFolded(id) ? state.controlCenter.collapsed.filter((other) => other !== id) : [...state.controlCenter.collapsed, id];
  save();
}

/** The scoreboard over the board: one tile per lane with its count; a tile folds its lane away and opens it again. */
function renderScoreboard(cards) {
  const board = element("div", "control-score");
  board.dataset.testid = "control-score";
  for (const column of COLUMNS) {
    const count = cards.filter((card) => card.column === column.id).length;
    // Nothing put aside needs no tile.
    if (column.id === "snoozed" && !count) continue;
    const tile = element("button", "control-score-tile");
    tile.type = "button";
    tile.dataset.column = column.id;
    tile.dataset.testid = `control-score-${column.id}`;
    const folded = isFolded(`lane:${column.id}`);
    tile.classList.toggle("folded", folded);
    tile.setAttribute("aria-pressed", String(!folded));
    tile.title = folded ? `Show ${column.title}` : `Fold ${column.title} into this tile`;
    tile.append(element("b", "", String(count)), element("span", "", column.id === "review" ? "To review" : column.title));
    tile.addEventListener("click", () => { toggleFolded(`lane:${column.id}`); render(); });
    board.append(tile);
  }
  const done = element("div", "control-score-tile done");
  done.dataset.testid = "control-score-finished";
  done.title = "Conversations that finished while you watched";
  done.append(element("b", "", `★ ${finishedWhileWatching}`), element("span", "", "Finished while watching"));
  board.append(done);
  return board;
}

const SPIN_MS = 1_000;

/**
 * A running card says so on top, with a ring that turns. The board is drawn anew every few seconds while agents run; the ring
 * starts each time where the clock says it is, so it keeps turning smoothly through those redraws.
 */
function runningBadge(card) {
  const badge = element("span", "control-badge running");
  badge.dataset.testid = "control-card-running";
  badge.title = card.turnRunning ? "Its agent is working now" : "Its background tasks are still running";
  const ring = element("span", "control-running-ring");
  ring.style.animationDelay = `-${Date.now() % SPIN_MS}ms`;
  badge.append(ring, element("span", "", "Running"));
  return badge;
}

/**
 * Where the conversation stands: what a running turn is doing now (its tool, or the last line it wrote), over the first sentence
 * of the summary's current state. Hover for the whole summary.
 */
function renderLive(card) {
  const live = element("div", "control-live");
  live.append(element("span", `control-pulse ${card.column === "running" ? "running" : "review"}`));
  const lines = element("div", "control-live-lines");
  const status = briefStatus(card.summary);
  if (card.activity) {
    live.classList.add("has-now");
    const now = element("span", "control-live-now", card.activity);
    now.dataset.testid = "control-card-activity";
    lines.append(now);
  }
  if (status || !card.activity) lines.append(element("span", "control-live-text", status ?? (card.column === "running" ? "Working…" : "Finished. Open it to review.")));
  live.append(lines);
  return live;
}

/** The first step waiting for the person, in the card's status room: the others follow once it is answered. */
function renderNeed(card) {
  const need = element("div", "control-need");
  need.dataset.testid = "control-center-need";
  const [review] = card.pendingReviews ?? [];
  if (review) {
    const more = card.pendingReviews.length - 1;
    need.title = [review.title, review.subject, review.detail].filter(Boolean).join("\n");
    need.append(element("div", "control-need-title", more ? `${review.title} · ${more} more` : review.title), element("div", "control-need-subject", review.subject));
    const buttons = element("div", "control-need-actions");
    for (const [decision, label, className] of [["allow", "Allow once", "control-action warn"], ["block", "Block", "control-action"]]) {
      const button = element("button", className, label);
      button.type = "button";
      button.dataset.testid = `control-review-${decision}`;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        button.disabled = true;
        api("/api/control-center/guardian/decide", { method: "POST", body: JSON.stringify({ projectId: card.projectId, conversationId: card.conversationId, reviewId: review.id, decision }) })
          .then(() => refreshControlCenter()).catch((error) => { toast.error(error.message); button.disabled = false; });
      });
      buttons.append(button);
    }
    need.append(buttons);
    return need;
  }
  const reason = card.autoRespondStop.reason || card.autoRespondStop.kind;
  need.title = `Auto respond stopped\n${reason}`;
  need.append(element("div", "control-need-title", "Auto respond stopped"), element("div", "control-need-subject", reason));
  return need;
}

/** What Bob found when the conversation stopped: done, told to go on, or waiting for the person. */
function checkLine(card) {
  const check = card.reviewCheck;
  if (!check) return null;
  const text = check.needsYou && card.column === "needs-you" ? `✋ Not done, waits for you${check.reason ? `: ${check.reason}` : ""}`
    : check.pushPending && card.column === "running" ? `↻ Bob told it to go on (${check.pushes} of 3)`
    : check.verdict === "done" && card.column === "review" ? "✓ Bob checked: done"
    : null;
  if (!text) return null;
  const line = element("div", `control-check ${check.needsYou ? "needs" : check.verdict}`, text);
  line.title = check.by;
  line.dataset.testid = "control-card-check";
  return line;
}

/**
 * Who moves a conversation forward when the person is not in it: the system answering for the agent (auto respond), or Bob
 * watching it because he started it. Null for the person's own conversations.
 */
function driverOf(card) {
  if (card.controlledBy === "you") return { id: "you-in", label: "✋ You're in it", title: "You took control; Bob and auto respond stay out" };
  if (card.autoRespondActive) return { id: "system", label: "⚙ System drives", title: "Auto respond answers this agent for you, and Bob is told when it stops" };
  if (card.reviewCheck?.pushPending && card.column === "running") return { id: "system", label: "⚙ System drives", title: "It stopped before it was done, so Bob told it to go on" };
  if (card.startedBy === "bob") return { id: "watched", label: "👁 Bob watches", title: "Bob started this and tells you when it needs you" };
  return null;
}

// Each lane groups its conversations by project, projects in name order and the newest conversation first, so a project's work sits together.
const byProjectThenNewest = (a, b) => a.projectName.localeCompare(b.projectName) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");

function renderProjectGroup(cards) {
  const [first] = cards;
  const group = element("div", "control-project-group");
  group.dataset.testid = "control-project-group";
  group.dataset.project = first.projectId;
  group.dataset.color = projectColor(first.projectId);
  const header = element("div", "control-project-head");
  header.append(element("b", "", first.projectName), element("span", "control-project-count", String(cards.length)));
  const project = { projectId: first.projectId, projectName: first.projectName };
  for (const action of projectActionList(project)) {
    const button = element("button", "control-card-action", action.label);
    button.type = "button";
    button.title = action.title;
    button.dataset.testid = `control-project-action-${action.id}`;
    button.addEventListener("click", () => Promise.resolve(action.run(project)).catch((error) => toast.error(error.message)));
    header.append(button);
  }
  const list = element("div", "control-project-cards");
  list.append(...cards.map(renderCard));
  group.append(header, list);
  return group;
}

function renderLanes(container, cards) {
  for (const column of COLUMNS) {
    const inColumn = cards.filter((card) => card.column === column.id).sort(byProjectThenNewest);
    if (!inColumn.length) continue;
    const heading = element("div", "control-lane");
    heading.dataset.column = column.id;
    const folded = isFolded(`lane:${column.id}`);
    const fold = element("button", "ghost compact control-lane-fold", folded ? "▸" : "▾");
    fold.type = "button";
    fold.title = folded ? `Show ${column.title}` : `Fold ${column.title}`;
    fold.setAttribute("aria-expanded", String(!folded));
    fold.dataset.testid = `control-lane-fold-${column.id}`;
    fold.addEventListener("click", () => { toggleFolded(`lane:${column.id}`); render(); });
    heading.append(fold, element("b", "", column.title), element("span", "control-lane-count", String(inColumn.length)), element("span", "", folded ? "" : column.hint));
    heading.classList.toggle("folded", folded);
    if (folded) { container.append(heading); continue; }
    const groups = element("div", "control-lane-groups");
    for (let index = 0; index < inColumn.length;) {
      const end = inColumn.findIndex((card, at) => at > index && card.projectId !== inColumn[index].projectId);
      const stop = end < 0 ? inColumn.length : end;
      groups.append(renderProjectGroup(inColumn.slice(index, stop)));
      index = stop;
    }
    container.append(heading, groups);
  }
}

function render() {
  // The chat follows the board's focus: one project chosen here filters it to that project.
  window.dispatchEvent(new CustomEvent("control-center-rendered", { detail: { projects: board.projects, cards: board.cards, focus: [...state.controlCenter.filter] } }));
  renderFilters();
  const container = elements.controlCenterBoard;
  container.replaceChildren();
  const cards = visibleCards();
  const waiting = cards.filter((card) => card.column === "needs-you").length;
  const driven = cards.filter((card) => driverOf(card)?.id === "system").length;
  const watched = cards.filter((card) => driverOf(card)?.id === "watched").length;
  elements.controlCenterCount.textContent = [
    `${cards.filter((card) => card.column === "running").length} running`, waiting ? `${waiting} need you` : "",
    driven ? `${driven} driven by the system` : "", watched ? `${watched} watched by Bob` : "",
  ].filter(Boolean).join(" · ");
  liveView.setBadge(cards.filter((card) => card.column === "needs-you" || card.column === "running").length);
  container.append(renderScoreboard(cards));
  if (!cards.length) {
    container.append(element("p", "control-empty", board.cards.length ? "Nothing matches the project filter." : "No conversations are running and nothing is waiting for review."));
    return;
  }
  renderLanes(container, cards);
  cheer(container);
}

/** Cards marked done here, with the word their way out shows. */
const settledHere = new Map();

/**
 * Cards no longer on the board leave with an animation, all together: a check and what settled them for one marked done here,
 * a fade for the rest. The cards that stay then glide to their new places.
 */
async function drawBoard(next) {
  const container = elements.controlCenterBoard;
  if (isControlCenterOpen()) {
    const keys = new Set(next.cards.map(cardKey));
    const gone = [...container.querySelectorAll(".control-card")].filter((node) => !keys.has(node.dataset.key));
    await Promise.all(gone.map((node) => vanish(node, settledHere.get(node.dataset.key))));
    for (const node of gone) settledHere.delete(node.dataset.key);
  }
  const before = positions(container, ".control-card");
  noteFinished(board.cards, next.cards);
  countSteps(next.cards);
  board = next;
  render();
  glide(container, ".control-card", before);
}

export function refreshControlCenter() {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      await drawBoard(await api("/api/control-center/board"));
    } while (refreshAgain);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * Opens a conversation by its project and conversation id (or its path), the way a card does. From the control center it
 * opens over the board, with the person in control (control-lease.js). Closing it goes back to the board.
 */
export async function openConversation(card) {
  const overBoard = isControlCenterOpen();
  state.keepControlView = overBoard;
  try {
    if (state.activeProjectId !== card.projectId) await selectProject(card.projectId);
    const session = state.sessions.find((candidate) => (candidate.conversationId ?? candidate.id) === card.conversationId) ?? (card.path ? state.sessions.find((candidate) => candidate.path === card.path) : undefined);
    if (!session) {
      toast("That conversation is no longer listed");
      await refreshControlCenter();
      return;
    }
    if (overBoard) {
      document.body.classList.add("control-popup");
      window.dispatchEvent(new CustomEvent("control-popup-opened", { detail: card }));
    }
    await openListedSession(session);
  } finally {
    state.keepControlView = false;
  }
}

export function closeConversationPopup() {
  if (!document.body.classList.contains("control-popup")) return;
  document.body.classList.remove("control-popup");
  window.dispatchEvent(new CustomEvent("control-popup-closed"));
}

const openCard = openConversation;

/** Focuses the board on one project, or on all of them with null. Bob's chat calls it when its project filter changes. */
export function focusProject(projectId) {
  state.controlCenter.filter = projectId ? [projectId] : [];
  save();
  render();
}

/**
 * Closes a conversation as its project's list does, with the same question about what to learn; a working one is stopped
 * first. Home's cards (home.js) call it too. Resolves true once it is closed, false when the question was dismissed.
 */
export async function markDone(card) {
  const feedback = await chooseConversationFeedback(card);
  if (!feedback) return false;
  await api("/api/control-center/cards/done", {
    method: "POST", body: JSON.stringify({ projectId: card.projectId, conversationId: card.conversationId, feedback }),
  });
  settledHere.set(cardKey(card), "Done");
  await refreshControlCenter();
  return true;
}

/** Push it on from a card: the conversation is told to go on, with what the person wrote (it can be empty). */
export async function pushOn(card, note = "") {
  await api("/api/control-center/cards/push", {
    method: "POST", body: JSON.stringify({ projectId: card.projectId, conversationId: card.conversationId, ...(note ? { note } : {}) }),
  });
  await refreshControlCenter();
}

/** Allow once or Block for the Guardian step a card waits on. */
export async function decideReview(card, review, decision) {
  await api("/api/control-center/guardian/decide", { method: "POST", body: JSON.stringify({ projectId: card.projectId, conversationId: card.conversationId, reviewId: review.id, decision }) });
  await refreshControlCenter();
}

function doneButton(card) {
  const button = element("button", "control-card-action control-card-done", "✓ ");
  button.append(element("span", "control-word", "Done"));
  button.type = "button";
  button.title = card.turnRunning
    ? "Stop it and close it: it leaves the board, and you can open it again from its project"
    : "Close it: it leaves the board, and you can open it again from its project";
  button.dataset.testid = "control-card-action-done";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    markDone(card).catch((error) => toast.error(error.message));
  });
  return button;
}

// Reviewing a finished conversation is reading it: opening it marks it reviewed, and it leaves the review lane.
registerCardAction({
  id: "review", label: "Review", style: "primary", order: 1, title: "Open it to read what it did; once you have looked, it leaves Done · ready for review",
  visible: (card) => card.column === "review", run: (card) => openConversation(card),
});
/** A conversation closed from Bob's chat: its card goes with the same check as the message, the next time the board is drawn. */
export function seeCardOff(projectId, conversationId, label) {
  settledHere.set(`${projectId}:${conversationId}`, label);
}

// Done or Abandon pressed in Bob's chat.
window.addEventListener("control-bob-action", ({ detail }) => {
  if (detail.actionId === "conversation.done" || detail.actionId === "conversation.abandon") seeCardOff(detail.data.projectId, detail.data.conversationId, detail.label);
});

/** A new conversation from the board: the quick note form, started at once, in the project the board is focused on. */
export function newConversation(content = "") {
  const focused = state.controlCenter.filter.length === 1 ? state.controlCenter.filter[0] : null;
  return openQuickNote(null, { chooseProject: true, startNow: true, projectId: focused, content });
}
registerBoardTool({ id: "new-conversation", label: "+ New conversation", title: "Start a conversation in any project, on any machine, with the agent you choose", order: 10, run: () => newConversation() });
// The card shows up as soon as the conversation has started, not at the next refresh.
window.addEventListener("conversation-started", () => { if (document.body.classList.contains("view-control")) void refreshControlCenter().catch(() => undefined); });

function resetBoard() {
  const { chatRight, chatWidth, view, collapsed } = state.controlCenter;
  state.controlCenter = { colors: {}, filter: [], chatRight, chatWidth, view, collapsed };
  save();
  render();
}

export function isControlCenterOpen() {
  return document.body.classList.contains("view-control");
}

/** Called by the chat to save the chat's side and width with the rest of the board's settings. */
export function saveControlCenter() { save(); }

export function activateControlCenter() {
  window.dispatchEvent(new CustomEvent("control-center-activated"));
  return refreshControlCenter();
}

const liveView = registerControlView({ id: "live", title: "Live agents", order: 0, element: elements.controlViewLive });

elements.controlCenterReset.addEventListener("click", resetBoard);
function renderBoardTools() {
  for (const old of elements.controlViewLive.querySelectorAll("[data-board-tool]")) old.remove();
  for (const tool of boardTools()) {
    const button = element("button", "ghost compact", tool.label);
    button.type = "button";
    button.title = tool.title;
    button.dataset.boardTool = tool.id;
    button.dataset.testid = `control-board-tool-${tool.id}`;
    button.addEventListener("click", () => Promise.resolve(tool.run()).catch((error) => toast.error(error.message)));
    elements.controlCenterReset.before(button);
  }
}
window.addEventListener("control-board-tools-changed", renderBoardTools);
renderBoardTools();
elements.controlCenterRefresh.addEventListener("click", () => refreshControlCenter().catch((error) => toast.error(error.message)));
// What waits for the person shows on the toolbar icon, so they know without opening the control center.
const badge = element("span", "control-icon-badge");
badge.hidden = true;
badge.dataset.testid = "control-center-waiting-badge";
elements.openControlCenterButton.append(badge);
let waitingChecked = Promise.resolve();
function refreshWaiting() {
  waitingChecked = waitingChecked.then(() => api("/api/control-center/summary")).then(({ waiting }) => {
    badge.textContent = waiting > 99 ? "99+" : String(waiting);
    badge.hidden = waiting === 0;
    elements.openControlCenterButton.setAttribute("aria-label", waiting ? `Open the control center, ${waiting} waiting for you` : "Open the control center");
  }).catch((error) => console.warn("Could not read what waits for you", error));
}
// The running list and the server already announce every change; the board and the badge follow the same signals.
function onChanged() {
  if (isControlCenterOpen()) refreshControlCenter().catch((error) => console.warn("Could not refresh the control center", error));
  refreshWaiting();
}
window.addEventListener("running-refreshed", onChanged);
// What a running turn is doing changes all the time, so while the board is in view and something runs it is read again.
const LIVE_REFRESH_MS = 10_000;
setInterval(() => {
  if (!isControlCenterOpen() || document.hidden || !board.cards.some((card) => card.column === "running")) return;
  refreshControlCenter().catch((error) => console.warn("Could not refresh the control center", error));
}, LIVE_REFRESH_MS);
window.addEventListener("control-center-changed", onChanged);
// Leaving the control center closes the conversation over it.
window.addEventListener("app-view-changed", () => { if (!isControlCenterOpen()) closeConversationPopup(); });
// Esc closes the conversation over the board before it can leave the control center, from its message box too (the draft
// stays); an open command list closes first.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || !document.body.classList.contains("control-popup")) return;
  if (document.querySelector("dialog[open]")) return;
  if (event.target === elements.messageInput ? !elements.commandAutocomplete.hidden : event.target.closest?.("input, textarea, select")) return;
  event.preventDefault();
  closeConversationPopup();
}, true);
