// The two lists of the desktop left column's Projects place (the projects, and one project's conversations) fit the
// column and page, as the Inbox groups do: a list shows the whole rows that fit and ‹ "1–8 of 31" › under it, never a
// scroll bar or a cut row. project-list.js and session-list.js keep drawing every row; a page is a scroll position of
// the list (overflow hidden, the rows of the next page clipped off), so its listeners, menus and test ids stay as they
// are, and anything that brings a row into view (the keyboard, a search, a test) lands on that row's page. A page that
// would end on a heading (a group of projects, Worktrees, a worktree, Project folder) carries that heading to the next
// page. The open project's or conversation's page is shown when it changes. The phone (body.focus-ui) keeps its
// scrolling lists.

import { state } from "./state.js";

const desktop = matchMedia("(min-width: 701px)");
/** The pager's line under the list (styles: .ws-session-pager). */
const PAGER_HEIGHT = 32;
const SVG = "http://www.w3.org/2000/svg";

const isRow = (node) => node.classList.contains("list-row");
const visible = (node) => node.getClientRects().length > 0;

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

/**
 * Pages `list`. `items()` gives its rows and headings in order (a heading is whatever is not a `.list-row`);
 * `plain(node)` says a node is neither (a "nothing here" line), so it never moves with the rows after it.
 */
function pageList({ list, testid, label, items, plain = () => false }) {
  const pager = document.createElement("nav");
  pager.className = "settings-pager list-pager ws-session-pager";
  pager.dataset.testid = `${testid}-pager`;
  pager.setAttribute("aria-label", label);
  pager.hidden = true;
  const previous = pagerButton("Previous page", `${testid}-page-previous`, "m15 18-6-6 6-6", () => { page -= 1; paginate(); });
  const position = document.createElement("span");
  position.className = "list-pager-label";
  position.dataset.testid = `${testid}-page-label`;
  position.setAttribute("aria-live", "polite");
  const next = pagerButton("Next page", `${testid}-page-next`, "m9 18 6-6-6-6", () => { page += 1; paginate(); });
  pager.append(previous, position, next);
  list.after(pager);

  let page = 0;
  let pages = [];
  let followActive = true;
  /** The scroll position this module set last; any other is someone bringing a row into view. */
  let placedAt = -1;
  /** The list was drawn again since its page was placed: the browser put it back at its top, nobody scrolled it. */
  let redrawn = false;

  const isHeading = (node) => !isRow(node) && !plain(node);

  function enabled() {
    return desktop.matches && !document.body.classList.contains("focus-ui") && document.body.classList.contains("ws-column-projects")
      && list.getClientRects().length > 0;
  }

  /** The list's rows and headings split into pages of `room` pixels: each page is its nodes, its top and its end. */
  function pagesOf(room) {
    const result = [];
    let current = null;
    // Larger text zooms the column: boxes are measured on screen, the list scrolls in its own pixels.
    const frame = list.getBoundingClientRect();
    const scale = list.offsetHeight ? frame.height / list.offsetHeight || 1 : 1;
    const at = (y) => (y - frame.top) / scale + list.scrollTop;
    for (const node of items().filter(visible)) {
      const box = node.getBoundingClientRect();
      const start = at(box.top);
      const end = at(box.bottom);
      // A page holds at least one row, even when its heading and the row are taller than the room.
      if (current && end - current.top > room && current.nodes.some(isRow)) {
        // A heading never ends a page: it moves with the rows it heads.
        const carried = [];
        while (current.nodes.length > 1 && isHeading(current.nodes.at(-1))) carried.unshift(current.nodes.pop());
        result.push(current);
        const first = carried[0] ?? node;
        current = { nodes: carried, top: at(first.getBoundingClientRect().top) };
      }
      if (!current) current = { nodes: [], top: start };
      current.nodes.push(node);
      current.end = end;
    }
    if (current) result.push(current);
    for (const item of result) {
      const last = item.nodes.at(-1);
      item.end = last ? at(last.getBoundingClientRect().bottom) : item.top;
    }
    return result;
  }

  function place() {
    redrawn = false;
    const current = pages[page];
    const top = Math.round(current?.top ?? 0);
    // A last page shorter than the list could not be scrolled to its top (the page before it came back at once), and
    // an only page that starts under a margin lost its last pixels: the list gets the room under its last row.
    const last = pages.at(-1);
    const room = last && last.top > 0 ? Math.max(0, Math.ceil(list.clientHeight - (last.end - last.top))) : 0;
    if (list.style.paddingBottom !== `${room}px`) list.style.paddingBottom = room ? `${room}px` : "";
    list.scrollTop = top;
    placedAt = list.scrollTop;
    // The next page's rows below this one are clipped off, so no row shows cut in half.
    const shown = current ? current.end - list.scrollTop : list.clientHeight;
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
      list.style.paddingBottom = "";
      pages = [];
      return;
    }
    list.classList.add("ws-paged");
    // The pager has its own line under the list: the room is the list's height without it.
    const full = list.clientHeight + (pager.hidden ? 0 : pager.offsetHeight);
    pages = pagesOf(full);
    if (pages.length > 1) pages = pagesOf(full - PAGER_HEIGHT);
    if (followActive) {
      const active = list.querySelector(".list-row.active");
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
    // The lists are drawn again on every background refresh, which resets their scroll position: the page stays.
    if (redrawn) { place(); return; }
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

  new MutationObserver((records) => {
    if (records.some((record) => record.type === "childList" && record.target === list)) redrawn = true;
    schedule();
  }).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden"] });
  let lastHeight = 0;
  new ResizeObserver(() => {
    if (Math.abs(list.clientHeight - lastHeight) < 1) return;
    lastHeight = list.clientHeight;
    schedule();
  }).observe(list);
  window.addEventListener("workspace-column-changed", schedule);
  desktop.addEventListener("change", schedule);

  return {
    /** Draw the pages again; `first` starts from the first page, `follow` shows the open row's page. */
    refresh({ first = false, follow = false } = {}) {
      if (first) page = 0;
      if (follow) followActive = true;
      schedule();
    },
  };
}

const sessionList = document.getElementById("sessionList");
const sessions = pageList({
  list: sessionList,
  testid: "session-list",
  label: "Pages of conversations",
  items: () => [...sessionList.children],
  plain: (node) => node.matches("p, .other-worktrees"),
});
// "activeConversationChanged" is announced on every redraw of the chat controls (about once a second while an agent
// works), not only when another conversation opens: the list goes to the open conversation's page only when that
// conversation is another one. Otherwise the page the reader chose would be taken back a second later.
let openConversation = "";
document.addEventListener("activeConversationChanged", () => {
  const key = `${state.activeConversationProjectId || state.activeProjectId || ""}|${state.activeSessionId || ""}|${state.activeSessionPath || ""}`;
  if (key === openConversation) return;
  openConversation = key;
  sessions.refresh({ follow: true });
});
// Another search or filter is another list: it starts on its first page.
const firstPageOfSessions = () => sessions.refresh({ first: true });
document.getElementById("sessionSearchInput").addEventListener("input", firstPageOfSessions);
for (const id of ["chatFilters", "conversationFilterRow", "showDoneConversations", "showScheduledConversations"]) {
  document.getElementById(id).addEventListener("click", firstPageOfSessions);
  document.getElementById(id).addEventListener("change", firstPageOfSessions);
}

// The projects are grouped (Personal, Work, a machine): a group's label heads its rows, and a folded group is its label alone.
const projectList = document.getElementById("projectList");
const projects = pageList({
  list: projectList,
  testid: "project-list",
  label: "Pages of projects",
  items: () => [...projectList.children].flatMap((node) => (node.matches("details") ? [...node.children] : [node])),
  plain: (node) => node.matches("p"),
});

const firstPageOfProjects = () => projects.refresh({ first: true });
document.getElementById("projectSearchInput").addEventListener("input", firstPageOfProjects);
document.getElementById("projectFilterRow").addEventListener("change", firstPageOfProjects);

let openProject = "";
window.addEventListener("project-selected", (event) => {
  // The same project chosen again (a refresh selects it again) keeps both pages.
  const projectId = event.detail?.projectId ?? "";
  if (projectId === openProject) return;
  openProject = projectId;
  sessions.refresh({ first: true, follow: true });
  projects.refresh({ follow: true });
});
