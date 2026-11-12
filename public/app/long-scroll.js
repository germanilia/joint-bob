/**
 * Long lists of conversations, projects and workspaces are one continuous list that scrolls (no Previous/Next pages, no
 * "1–8 of 80"). A long list is drawn in chunks: the first CHUNK rows, then CHUNK more each time the person scrolls near
 * the end, so five hundred rows stay fast. Rule: .agents/knowledge/list-scrolling.md.
 *
 * Two shapes:
 *  - `drawChunked(host, entries, options)` for lists a render rebuilds whole (the conversations, the projects, a group's page).
 *    The rendered count and the scroll position outlive the rebuild: a background refresh draws the same rows again and
 *    puts the list where it was; a different `key` (another project, search or filter) is another list and starts at the top.
 *  - `createChunkedList(options)` for Settings lists that keep a `render()` of their own: `slice(items)` gives the rows to
 *    draw, `update()` watches the end of the list.
 *
 * The sentinel at the end of the list is watched by an IntersectionObserver whose root is the list's own scroll box (or the
 * page, when the page scrolls on a phone), with a margin of two screens, so rows are there before they are seen.
 */

export const CHUNK = 40;
/** Rows past the one that must be shown (the open conversation, a revealed row): room to scroll on from it. */
const SPARE = 10;

const states = new WeakMap();

/** The box that scrolls the list: its own, or the nearest ancestor's, or null for the page. */
export function scrollerOf(node) {
  for (let element = node; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return element;
  }
  return null;
}

function setScroll(scroller, top) {
  if (scroller) scroller.scrollTop = top;
  else window.scrollTo(0, top);
}

/**
 * Draws `entries` (nodes, or functions that make one) into `host`, after what the caller already put there.
 * An entry may be `{ make, into }` to land in another element of the list (a group's own box); such rows follow the same count.
 * `key` names the list being shown: when it changes the list starts at its top with the first chunk again.
 * `ensure` is the index of an entry that must be drawn (the open conversation). Returns what was drawn and how many there are.
 */
export function drawChunked(host, entries, { key = "", ensure = -1, size = CHUNK } = {}) {
  let state = states.get(host);
  if (!state) { state = { key, count: size, observer: null, sentinel: null, entries: [], next: 0 }; states.set(host, state); }
  state.observer?.disconnect();
  state.sentinel?.remove();
  const changed = state.key !== key;
  if (changed) { state.key = key; state.count = size; }
  state.size = size;
  state.entries = entries;
  state.host = host;
  if (ensure >= 0) state.count = Math.max(state.count, ensure + 1 + SPARE);
  state.count = Math.min(Math.max(state.count, size), Math.max(entries.length, size));
  state.next = 0;
  state.sentinel = Object.assign(document.createElement("div"), { className: "long-scroll-sentinel" });
  state.sentinel.setAttribute("aria-hidden", "true");
  host.append(state.sentinel);
  drawUpTo(state, state.count);
  watch(state);
  if (changed) {
    // The caller restores the scroll position of a rebuilt list in a microtask; another list starts at its top after that.
    const scroller = scrollerOf(host);
    queueMicrotask(() => setScroll(scroller, 0));
  }
  return { shown: state.next, total: entries.length };
}

function drawUpTo(state, count) {
  const { host, entries, sentinel } = state;
  const stop = Math.min(count, entries.length);
  for (; state.next < stop; state.next += 1) {
    const entry = entries[state.next];
    const into = entry && typeof entry === "object" && "make" in entry ? entry.into : undefined;
    const made = entry && typeof entry === "object" && "make" in entry ? entry.make() : typeof entry === "function" ? entry() : entry;
    if (!made) continue;
    if (into && into !== host) into.append(made); else sentinel.before(made);
  }
  host.dataset.rendered = String(state.next);
  host.dataset.total = String(entries.length);
}

function watch(state) {
  const { host, sentinel } = state;
  if (state.next >= state.entries.length) { sentinel.remove(); return; }
  if (typeof IntersectionObserver !== "function") { drawUpTo(state, state.entries.length); sentinel.remove(); return; }
  const root = scrollerOf(host);
  state.observer = new IntersectionObserver((records) => {
    if (!records.some((record) => record.isIntersecting)) return;
    state.count = Math.min(state.entries.length, state.count + state.size);
    drawUpTo(state, state.count);
    if (state.next >= state.entries.length) { state.observer.disconnect(); sentinel.remove(); return; }
    // Still in view (a tall window, short rows): look again for the next chunk.
    state.observer.unobserve(sentinel);
    state.observer.observe(sentinel);
  }, { root, rootMargin: "0px 0px 1200px 0px" });
  state.observer.observe(sentinel);
}

/** For tests and callers that need the next chunk now, such as keyboard navigation reaching the last drawn row. */
export function drawMore(host, size = CHUNK) {
  const state = states.get(host);
  if (!state || state.next >= state.entries.length) return false;
  state.count = Math.min(state.entries.length, state.count + size);
  drawUpTo(state, state.count);
  if (state.next >= state.entries.length) { state.observer?.disconnect(); state.sentinel.remove(); }
  return true;
}

/**
 * A Settings list that draws its own rows: `slice(items, show)` is what to draw (the first chunk, or more once the person
 * scrolled; `show` is an index that must be drawn), `reset()` starts the next draw from the first chunk again, and
 * `update()` is called after the rows are drawn: it puts the sentinel after the list and asks `render()` for more rows when it
 * is reached. The list's own box is not changed; the section scrolls.
 */
export function createChunkedList({ list, render, size = CHUNK }) {
  let count = size, total = 0, observer = null;
  const sentinel = Object.assign(document.createElement("div"), { className: "long-scroll-sentinel" });
  sentinel.setAttribute("aria-hidden", "true");
  list.classList.add("long-list", "chunked");
  list.parentElement?.classList.add("long-list-group");
  return {
    slice(items, show = -1) {
      total = items.length;
      if (show >= 0) count = Math.max(count, show + 1 + SPARE);
      count = Math.min(Math.max(count, size), Math.max(total, size));
      list.dataset.total = String(total);
      list.dataset.rendered = String(Math.min(count, total));
      return items.slice(0, count);
    },
    reset() { count = size; },
    update() {
      observer?.disconnect();
      sentinel.remove();
      if (count >= total) return;
      list.after(sentinel);
      if (typeof IntersectionObserver !== "function") { count = total; render(); return; }
      observer = new IntersectionObserver((records) => {
        if (!records.some((record) => record.isIntersecting)) return;
        count = Math.min(total, count + size);
        observer.disconnect();
        render();
      }, { root: scrollerOf(list), rootMargin: "0px 0px 1200px 0px" });
      observer.observe(sentinel);
    },
  };
}
