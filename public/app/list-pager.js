/**
 * Long lists in Settings (Browser profiles, Secrets, Workspaces) never grow their section. A list
 * shows the whole rows that fit between its top and the bottom of the section (keeping in view what
 * follows it in its group: the pager, a status line, an add row), and pages with
 * Previous / "1–8 of 31" / Next, like fitPage in resources.js. Rows share one fixed height
 * (styles.css), so the fit is one division; a single row taller than the room still shows and the
 * section scrolls. The fit is measured again whenever the section changes size.
 *
 * The caller owns the rows: `render()` filters its items, draws `pager.slice(items)` into the list
 * and calls `pager.update()`. `update()` may call `render()` once more when the fit changes.
 */
const SVG = "http://www.w3.org/2000/svg";

function chevron(path) {
  const icon = document.createElementNS(SVG, "svg");
  icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true"); icon.setAttribute("class", "list-pager-icon");
  const line = document.createElementNS(SVG, "path"); line.setAttribute("d", path); icon.append(line);
  return icon;
}

function pagerButton(label, testid, path, onClick) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "ghost list-pager-button"; button.dataset.testid = testid;
  button.setAttribute("aria-label", label); button.title = label;
  button.append(chevron(path));
  button.addEventListener("click", onClick);
  return button;
}

/**
 * @param {{ list: HTMLElement, prefix: string, label: string, render: () => void, rowClass?: string }} options
 *   `prefix` names the test ids (`<prefix>-pager`, `-page-label`, `-page-previous`, `-page-next`).
 */
export function createListPager({ list, prefix, label, render, rowClass = "long-list-row" }) {
  // `anchor`: the index a render was asked to show (a revealed or new row), kept through its refit.
  let page = 0, size = 8, total = 0, refitting = false, observer = null, measured = "", anchor = -1;
  list.classList.add("long-list");
  list.parentElement?.classList.add("long-list-group");

  const bar = document.createElement("nav");
  bar.className = "settings-pager list-pager"; bar.dataset.testid = `${prefix}-pager`; bar.setAttribute("aria-label", label); bar.hidden = true;
  const position = document.createElement("span");
  position.className = "list-pager-label"; position.dataset.testid = `${prefix}-page-label`; position.setAttribute("aria-live", "polite");
  const previous = pagerButton("Previous page", `${prefix}-page-previous`, "m15 18-6-6 6-6", () => go(page - 1));
  const next = pagerButton("Next page", `${prefix}-page-next`, "m9 18 6-6-6-6", () => go(page + 1));
  bar.append(previous, position, next);
  list.after(bar);

  function go(target) {
    page = target;
    render();
    // The last page disables Next under the pointer; keep the keyboard on the pager.
    if (document.activeElement === document.body || document.activeElement?.disabled) (next.disabled ? previous : next).focus();
  }

  function draw() {
    const pages = Math.max(1, Math.ceil(total / size));
    bar.hidden = total <= size;
    position.textContent = total ? `${page * size + 1}–${Math.min(total, (page + 1) * size)} of ${total}` : "";
    previous.disabled = page === 0;
    next.disabled = page >= pages - 1;
  }

  /** How many whole rows fit between the list's top and the section's bottom, leaving what follows the list in its group. */
  function fit() {
    const panel = list.closest(".settings-panel");
    if (!panel) return;
    // The room is the section's size and where the list starts in it.
    const layout = () => `${panel.clientWidth}x${panel.clientHeight}@${Math.round(list.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop)}`;
    if (!observer) {
      // The section and everything in it are watched, so a head that grows (a font arriving, a wrapped
      // line) refits too. Redrawn on the next frame, not inside the observer, so it cannot loop.
      observer = new ResizeObserver(() => requestAnimationFrame(() => {
        if (panel.clientHeight && list.getClientRects().length && layout() !== measured) render();
      }));
      for (const element of [panel, ...panel.children]) observer.observe(element);
    }
    const rows = [...list.children].filter((child) => child.classList.contains(rowClass));
    if (!rows.length || !panel.clientHeight || !list.getClientRects().length) return;
    measured = layout();
    const panelBox = panel.getBoundingClientRect(), listBox = list.getBoundingClientRect();
    const top = listBox.top - panelBox.top - panel.clientTop + panel.scrollTop;
    // What follows the list in its group (the pager, a status line, an add row) stays in view with it.
    let after = 0;
    for (let sibling = list.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      if (sibling.getClientRects().length) after = Math.max(after, sibling.getBoundingClientRect().bottom - listBox.bottom);
    }
    const bottom = Math.min(parseFloat(getComputedStyle(panel).paddingBottom) || 0, 24);
    const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
    const rowHeight = Math.max(...rows.map((row) => row.offsetHeight)) + gap;
    // The pager takes room once there is more than one page, so it is always counted.
    const pagerRoom = bar.hidden ? 52 : 0;
    const fits = Math.max(1, Math.floor((panel.clientHeight - top - after - pagerRoom - bottom + gap) / rowHeight));
    // Only shrinking may follow a refit, so a refit always settles.
    if (fits === size || (refitting && fits > size)) return;
    // The page keeps its first row, or the row it was asked to show.
    const first = anchor >= 0 ? anchor : page * size;
    size = fits;
    page = Math.floor(first / size);
    refitting = true;
    try { render(); } finally { refitting = false; }
  }

  return {
    element: bar,
    /** The current page of `items`; `show` (an index) turns to the page holding that item. Clamps after deletes. */
    slice(items, show = -1) {
      total = items.length;
      if (show >= 0) { page = Math.floor(show / size); anchor = show; }
      page = Math.min(Math.max(page, 0), Math.max(0, Math.ceil(total / size) - 1));
      return items.slice(page * size, (page + 1) * size);
    },
    /** A new filter starts again on the first page. */
    reset() { page = 0; },
    /** After the rows are drawn: the pager, then a refit if the room changed. */
    update() {
      draw();
      if (refitting) return void fit();
      try { fit(); } finally { anchor = -1; }
    },
  };
}

/**
 * A row's actions. On a desktop they sit in the row; on a phone (≤ 700 px) they fold behind a ⋯
 * button and open as a small menu above the section, so every action stays one tap away and the
 * row keeps its height. The actions element is a popover inside the Settings dialog, so it is
 * never inert behind it.
 */
export function rowActions(buttons, label) {
  const actions = document.createElement("span");
  actions.className = "long-row-actions";
  actions.popover = "auto";
  actions.append(...buttons);
  const more = document.createElement("button");
  more.type = "button"; more.className = "ghost long-row-more"; more.textContent = "⋯";
  more.setAttribute("aria-label", label); more.title = label;
  more.popoverTargetElement = actions;
  actions.addEventListener("toggle", (event) => {
    more.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState !== "open") return;
    const anchor = more.getBoundingClientRect(), box = actions.getBoundingClientRect();
    actions.style.left = `${Math.min(Math.max(8, anchor.right - box.width), innerWidth - box.width - 8)}px`;
    const below = anchor.bottom + 6;
    actions.style.top = `${below + box.height > innerHeight - 8 ? Math.max(8, anchor.top - box.height - 6) : below}px`;
  });
  // A chosen action closes the menu before it runs its own dialog.
  actions.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("button") && actions.matches(":popover-open")) actions.hidePopover();
  });
  more.setAttribute("aria-expanded", "false");
  return { actions, more };
}
