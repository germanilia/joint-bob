// A project's conversations in the desktop left column (Projects) fit the column and page, as the Inbox groups do:
// the list shows the whole rows that fit and ‹ "1–8 of 31" › under it, never a scroll bar or a cut row. session-list.js
// keeps drawing every row; a page is a scroll position of the list (overflow hidden, the rows of the next page clipped
// off), so its listeners, menus and test ids stay as they are, and anything that brings a row into view (the keyboard,
// a search, a test) lands on that row's page. A page that would end on a heading (Worktrees, a worktree, Project
// folder) carries that heading to the next page. The open conversation's page is shown when the open conversation
// changes. The phone (body.focus-ui) keeps its scrolling list.

const desktop = matchMedia("(min-width: 701px)");
const list = document.getElementById("sessionList");
/** The pager's line under the list (styles: .ws-session-pager). */
const PAGER_HEIGHT = 36;

const pager = document.createElement("nav");
pager.className = "settings-pager list-pager ws-session-pager";
pager.dataset.testid = "session-list-pager";
pager.setAttribute("aria-label", "Pages of conversations");
pager.hidden = true;
const SVG = "http://www.w3.org/2000/svg";
function pagerButton(label, testid, path, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost list-pager-button";
  button.dataset.testid = testid;
  button.setAttribute("aria-label", label);
  button.title = label;
  const icon = document.createElementNS(SVG, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("class", "list-pager-icon");
  const line = document.createElementNS(SVG, "path");
  line.setAttribute("d", path);
  icon.append(line);
  button.append(icon);
  button.addEventListener("click", onClick);
  return button;
}
const previous = pagerButton("Previous page", "session-list-page-previous", "m15 18-6-6 6-6", () => { page -= 1; paginate(); });
const position = document.createElement("span");
position.className = "list-pager-label";
position.dataset.testid = "session-list-page-label";
position.setAttribute("aria-live", "polite");
const next = pagerButton("Next page", "session-list-page-next", "m9 18 6-6-6-6", () => { page += 1; paginate(); });
pager.append(previous, position, next);
list.after(pager);

let page = 0;
let pages = [];
let followActive = true;
/** The scroll position this module set last; any other is someone bringing a row into view. */
let placedAt = -1;

function enabled() {
  return desktop.matches && !document.body.classList.contains("focus-ui") && document.body.classList.contains("ws-column-projects")
    && list.getClientRects().length > 0;
}

const isRow = (node) => node.classList.contains("list-row");
const isHeading = (node) => !isRow(node) && !node.matches("p, .other-worktrees");
const visible = (node) => node.getClientRects().length > 0;

/** The list's children split into pages of `room` pixels: each page is its children, its top and its height. */
function pagesOf(room) {
  const result = [];
  let current = null;
  const top = list.getBoundingClientRect().top - list.scrollTop;
  for (const node of [...list.children].filter(visible)) {
    const box = node.getBoundingClientRect();
    const start = box.top - top;
    const end = start + box.height;
    // A page holds at least one row, even when its heading and the row are taller than the room.
    if (current && end - current.top > room && current.nodes.some(isRow)) {
      // A heading never ends a page: it moves with the rows it heads.
      const carried = [];
      while (current.nodes.length > 1 && isHeading(current.nodes.at(-1))) carried.unshift(current.nodes.pop());
      result.push(current);
      const first = carried[0] ?? node;
      current = { nodes: carried, top: first.getBoundingClientRect().top - top };
    }
    if (!current) current = { nodes: [], top: start };
    current.nodes.push(node);
    current.end = end;
  }
  if (current) result.push(current);
  for (const item of result) {
    const last = item.nodes.at(-1);
    item.end = last ? last.getBoundingClientRect().bottom - top : item.top;
  }
  return result;
}

function place() {
  const current = pages[page];
  const top = Math.round(current?.top ?? 0);
  placedAt = top;
  list.scrollTop = top;
  // The next page's rows below this one are clipped off, so no row shows cut in half.
  const shown = current ? current.end - current.top : list.clientHeight;
  list.style.clipPath = `inset(0 0 ${Math.max(0, Math.floor(list.clientHeight - shown))}px 0)`;
  pager.hidden = pages.length <= 1;
  const rows = pages.flatMap((item) => item.nodes).filter(isRow);
  const before = pages.slice(0, page).flatMap((item) => item.nodes).filter(isRow).length;
  const here = (current?.nodes ?? []).filter(isRow).length;
  position.textContent = rows.length ? `${here ? before + 1 : before}–${before + here} of ${rows.length}` : "";
  previous.disabled = page === 0;
  next.disabled = page >= pages.length - 1;
}

function paginate() {
  if (!enabled()) {
    pager.hidden = true;
    list.classList.remove("ws-paged");
    list.style.clipPath = "";
    pages = [];
    return;
  }
  list.classList.add("ws-paged");
  // The pager has its own line under the list: the room is the list's height without it.
  const full = list.clientHeight + (pager.hidden ? 0 : pager.getBoundingClientRect().height);
  pages = pagesOf(full);
  if (pages.length > 1) pages = pagesOf(full - PAGER_HEIGHT);
  if (followActive) {
    const active = list.querySelector(":scope > .list-row.active");
    const at = active ? pages.findIndex((item) => item.nodes.includes(active)) : -1;
    if (at >= 0) page = at;
    followActive = false;
  }
  page = Math.max(0, Math.min(page, pages.length - 1));
  place();
}

/** Something scrolled the list (a row brought into view): show the page of the row now in the middle of it. */
list.addEventListener("scroll", () => {
  if (!pages.length || Math.abs(list.scrollTop - placedAt) < 1) return;
  const middle = list.scrollTop + list.clientHeight / 2;
  const at = pages.findIndex((item) => middle >= item.top && middle < item.end);
  page = at >= 0 ? at : pages.findIndex((item) => item.top >= list.scrollTop);
  if (page < 0) page = pages.length - 1;
  place();
}, { passive: true });

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; paginate(); });
}

new MutationObserver(schedule).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden"] });
let lastHeight = 0;
new ResizeObserver(() => {
  if (Math.abs(list.clientHeight - lastHeight) < 1) return;
  lastHeight = list.clientHeight;
  schedule();
}).observe(list);
document.addEventListener("activeConversationChanged", () => { followActive = true; schedule(); });
window.addEventListener("project-selected", () => { page = 0; followActive = true; schedule(); });
window.addEventListener("workspace-column-changed", schedule);
desktop.addEventListener("change", schedule);
