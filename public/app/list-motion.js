// How the conversation list moves (control-list.js). The list is rebuilt on every change, so nothing here is attached to a row:
// `capture` remembers what the rows looked like, `play` compares that with the rebuilt rows and animates the difference.
//   A row that changed place glides there (FLIP); one that was pinned lifts off the list while it flies and the pin drops in.
//   A new row slides in; a row whose status line changed slides the new line up, pops its dot and flashes.
//   A row that left is drawn once more where it was and leaves: marked done (a check draws itself, then it slides away),
//   deleted (it tips away to the left) or simply gone (it fades).
//   A starred row's star pops; a count that changed (the chips, the summary line) pops.
// Nothing moves when the list was just switched (scope, grouping, search, select mode), on the first draw, or when a change
// touches many rows at once: then the new list simply appears.

import { animate, bump, EASE_IN, flash, moving, plusOne, playful, sparks, spring } from "./motion.js";

const MANY = 8;

const rowsOf = (container) => [...container.querySelectorAll(".control-list-row[data-key]")];
const top = (node, container) => node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
const has = (node, title) => Boolean(node.querySelector(`.control-list-time [title="${title}"]`));
const COUNTS = ['[data-testid^="control-list-scope-"] em', '[data-testid^="control-list-count-"]', '[data-testid="control-score-finished"]'];

function countsOf(roots) {
  const found = new Map();
  for (const root of roots) for (const selector of COUNTS) for (const node of root.querySelectorAll(selector)) {
    const owner = node.closest("[data-testid]");
    found.set(`${owner.dataset.testid}`, node.textContent);
  }
  return found;
}

/** Remembers the rows (place, marks, status line) and the counts. `signature` names the view: another one means a switch, not a change. */
export function capture({ rows, chips }, signature) {
  const seen = new Map();
  for (const node of rowsOf(rows)) {
    seen.set(node.dataset.key, {
      node,
      y: top(node, rows),
      height: node.offsetHeight,
      pinned: has(node, "Pinned"),
      starred: has(node, "Starred"),
      column: node.dataset.column,
      text: node.querySelector(".control-list-snippet")?.textContent ?? "",
    });
  }
  return { signature, seen, counts: countsOf([chips, rows]) };
}

/** `leaving(key)` says how a row that is gone left: "done", "delete" or null (it just went). */
export function play({ rows, chips }, before, signature, leaving) {
  const quiet = !moving() || !before.seen.size || before.signature !== signature || !rows.offsetParent;
  if (!quiet) animateRows(rows, before, leaving);
  const counts = countsOf([chips, rows]);
  if (!before.seen.size || before.signature !== signature) return;
  for (const [id, text] of counts) {
    if (before.counts.get(id) === undefined || before.counts.get(id) === text) continue;
    const owner = [chips, rows].map((root) => root.querySelector(`[data-testid="${id}"]`)).find(Boolean);
    bump(owner.querySelector("em, b") ?? owner);
  }
}

function animateRows(rows, before, leaving) {
  const now = new Map(rowsOf(rows).map((node) => [node.dataset.key, node]));
  const gone = [...before.seen.keys()].filter((key) => !now.has(key));
  const added = [...now.keys()].filter((key) => !before.seen.has(key));
  const changed = [...now].filter(([key, node]) => before.seen.has(key) && (Math.abs(before.seen.get(key).y - top(node, rows)) > 1 || before.seen.get(key).text !== textOf(node))).length;
  if (gone.length > MANY || added.length > MANY || changed > MANY * 2) return;
  for (const key of gone) leave(rows, before.seen.get(key), leaving(key));
  for (const [key, node] of now) {
    const old = before.seen.get(key);
    if (!old) { enter(node); continue; }
    move(node, old, rows);
    mark(node, old);
  }
}

const textOf = (node) => node.querySelector(".control-list-snippet")?.textContent ?? "";

function enter(node) {
  animate(node, [{ opacity: 0, transform: "translateX(-18px)" }, { opacity: 1, transform: "none" }], 360, { easing: spring() });
  flash(node);
}

function move(node, old, rows) {
  const dy = old.y - top(node, rows);
  if (Math.abs(dy) > 1) {
    const pinning = node.classList.contains("control-list-row") && has(node, "Pinned") && !old.pinned;
    const ms = Math.min(620, 320 + Math.abs(dy) * 0.5);
    if (pinning) {
      node.classList.add("on-air");
      const lift = playful() ? 1.035 : 1.015;
      animate(node, [{ transform: `translateY(${dy}px)` }, { transform: `translateY(${dy * 0.6}px) scale(${lift})`, offset: 0.35 }, { transform: "none" }], ms + 80, { easing: spring() })
        .finished.then(() => node.classList.remove("on-air"), () => node.classList.remove("on-air"));
    } else animate(node, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], ms, { easing: playful() ? "cubic-bezier(.3,1.25,.6,1)" : "cubic-bezier(.2,.7,.2,1)" });
  }
}

/** What changed inside a row that is still there. */
function mark(node, old) {
  const pin = node.querySelector('.control-list-time [title="Pinned"]');
  if (pin && !old.pinned) {
    animate(pin, [{ opacity: 0, transform: "translateY(-14px) rotate(-40deg)" }, { opacity: 1, transform: "none" }], 460, { delay: 260, easing: spring(), fill: "backwards" });
    setTimeout(() => sparks(pin, { count: 6, distance: 16, colors: ["var(--accent)"], size: 4 }), 560);
  }
  const star = node.querySelector('.control-list-time [title="Starred"]');
  if (star && !old.starred) {
    animate(star, [{ transform: "scale(0) rotate(-90deg)" }, { transform: "scale(1.6) rotate(15deg)", offset: 0.6 }, { transform: "none" }], 520, { easing: spring() });
    setTimeout(() => sparks(star, { count: 10, distance: 26, colors: ["var(--amber)", "#ffd98a"], size: 5 }), 220);
  }
  if (textOf(node) !== old.text) newLine(node, old);
}

/** A new status line: it slides up into place, the dot pops and the row flashes (blue when it now waits to be reviewed, amber when it needs the person). */
function newLine(node, old) {
  const line = node.querySelector(".control-list-snippet");
  if (line) animate(line, [{ transform: "translateY(60%)", opacity: 0 }, { transform: "none", opacity: 1 }], 320, { delay: 70, easing: spring(), fill: "backwards" });
  const dot = node.querySelector(".control-list-dot");
  if (dot) animate(dot, [{ transform: "scale(0)" }, { transform: "scale(1.7)", offset: 0.5 }, { transform: "scale(1)" }], 420, { easing: spring() });
  const time = node.querySelector(".control-list-time");
  if (time) animate(time, [{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], 260);
  const color = node.dataset.column === "needs-you" ? "var(--amber-soft, rgba(240,180,90,.14))" : node.dataset.column === "review" ? "var(--blue-soft, rgba(142,162,255,.14))" : "var(--accent-soft)";
  flash(node, color, node.dataset.column === old.column ? 1000 : 1400);
}

/** The row that is gone is drawn again where it was, and leaves. */
function leave(rows, old, kind) {
  const ghost = old.node;
  ghost.classList.add("leaving");
  ghost.style.cssText = `position:absolute;left:0;right:0;top:${old.y}px;height:${old.height}px;margin:0;z-index:3;pointer-events:none`;
  rows.append(ghost);
  const remove = () => ghost.remove();
  if (kind === "done") return void done(ghost).then(remove, remove);
  if (kind === "delete") return void animate(ghost, [{ transform: "none", opacity: 1 }, { transform: "translateX(8px)", offset: 0.22 }, { transform: "translateX(-105%) rotate(-4deg)", opacity: 0 }], playful() ? 460 : 260, { easing: "cubic-bezier(.5,0,.75,0)", fill: "forwards" }).finished.then(remove, remove);
  animate(ghost, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-24px)" }], 220, { easing: EASE_IN, fill: "forwards" }).finished.then(remove, remove);
}

const SVG = "http://www.w3.org/2000/svg";

/** The check drawn in a circle, built as SVG nodes. */
function stampIcon() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const circle = document.createElementNS(SVG, "circle");
  for (const [name, value] of [["cx", "12"], ["cy", "12"], ["r", "10"]]) circle.setAttribute(name, value);
  const tick = document.createElementNS(SVG, "path");
  tick.setAttribute("d", "m7.5 12.5 3 3 6-7");
  svg.append(circle, tick);
  return svg;
}

/** A check draws itself over the row, then the row slides away; the Past count gets the "+1". */
async function done(ghost) {
  const stamp = document.createElement("div");
  stamp.className = "control-list-stamp";
  const label = document.createElement("span");
  label.textContent = "Marked done";
  stamp.append(stampIcon(), label);
  ghost.append(stamp);
  animate(stamp, [{ opacity: 0 }, { opacity: 1 }], 180);
  animate(stamp.querySelector("circle"), [{ strokeDashoffset: 63 }, { strokeDashoffset: 0 }], 340, { fill: "forwards" });
  animate(stamp.querySelector("path"), [{ strokeDashoffset: 16 }, { strokeDashoffset: 0 }], 220, { delay: 230, fill: "both" });
  if (playful()) {
    animate(ghost, [{ boxShadow: "0 0 0 0 transparent" }, { boxShadow: "0 0 0 3px var(--live), 0 0 24px var(--live)", offset: 0.45 }, { boxShadow: "0 0 0 0 transparent" }], 620);
    setTimeout(() => sparks(stamp.querySelector("svg"), { count: 16, distance: 70, gravity: 30, colors: ["var(--accent)", "var(--amber)", "var(--blue)", "#d47fb6", "var(--danger)"] }), 420);
  }
  await new Promise((resolve) => setTimeout(resolve, playful() ? 780 : 460));
  const past = document.querySelector('[data-testid="control-list-scope-past"]');
  if (past && playful()) plusOne(ghost, past);
  await animate(ghost, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(48px)" }], 260, { easing: EASE_IN, fill: "forwards" }).finished;
}
