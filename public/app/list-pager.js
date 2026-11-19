/**
 * Row actions for the long lists in Settings (Browser profiles, Secrets, Workspaces). The lists themselves are drawn in
 * chunks that the section scrolls (long-scroll.js, .agents/knowledge/list-scrolling.md); this file keeps what a row needs.
 */

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
