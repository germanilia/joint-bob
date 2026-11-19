/**
 * Row actions for the long lists in Settings (Browser profiles, Secrets, Workspaces). The lists themselves are drawn in
 * chunks that the section scrolls (long-scroll.js, .agents/knowledge/list-scrolling.md); this file keeps what a row needs.
 */

/**
 * A row's actions. The one that is used most (`primary`, a button) sits in the row; the others fold behind a ⋯ button and
 * open as a small menu above the section, so the row stays quiet and every action is one click away. In a narrow window
 * the primary action moves into the menu too, so the row keeps its height. The menu is a popover inside the
 * Settings dialog, so it is never inert behind it. Returns `controls`, the element to put in the row, with `actions` (the
 * menu) and `more` (the ⋯ button) for the caller's test ids.
 */
/** The main action of a row sits in the row in a wide window and in the ⋯ menu in a narrow one (the same button, so it keeps its test id). */
const narrowWindow = window.matchMedia("(max-width: 1100px)");
const primaryPlacements = new Set();
function placePrimary({ primary, controls, actions }) {
  if (narrowWindow.matches) actions.prepend(primary); else controls.prepend(primary);
}
narrowWindow.addEventListener("change", () => {
  for (const reference of primaryPlacements) {
    const placement = reference.deref();
    if (placement) placePrimary(placement); else primaryPlacements.delete(reference);
  }
});

export function rowActions(buttons, label, primary = null) {
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
  const controls = document.createElement("span");
  controls.className = "long-row-controls";
  controls.append(more, actions);
  if (primary) {
    primary.classList.add("long-row-primary");
    primaryPlacements.add(new WeakRef({ primary, controls, actions }));
    placePrimary({ primary, controls, actions });
  }
  return { controls, actions, more };
}
