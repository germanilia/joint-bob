import { createChoicePopover } from "./choice-popover.js";

/**
 * Every plain dropdown (<select>) opens the shared searchable list (choice-popover.js) instead
 * of the browser's own. The <select> stays the source of truth: it is still drawn, holds the
 * value, and gets `input` and `change` events when a choice is made, so code that builds or
 * reads it is unchanged. Opening is caught once for the whole page, so selects added later are
 * covered too. A select with `multiple`, a size over 1, or inside `[data-native-select]` keeps
 * the browser's list.
 */
let select = null;
let touchStart = null;

const choices = createChoicePopover({
  id: "selectSearch",
  testid: "select-search",
  detached: true,
  onChoose(choice) {
    if (!choice.option.selected) {
      choice.option.selected = true;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  },
  onClose({ focusAnchor }) {
    select.closest("dialog")?.removeEventListener("close", closeList);
    if (focusAnchor && select.isConnected) select.focus();
  },
});
const closeList = () => choices.close();

function searchable(target) {
  const candidate = target instanceof Element ? target.closest("select") : null;
  if (!candidate || candidate.multiple || candidate.size > 1 || candidate.disabled) return null;
  if (candidate.closest("[data-native-select]") || !candidate.options.length) return null;
  return candidate;
}

function labelOf(target) {
  return target.getAttribute("aria-label") || target.labels?.[0]?.textContent.trim() || target.title || "";
}

function choicesOf(target) {
  return [...target.options].filter((option) => !option.hidden).map((option) => {
    const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
    return {
      option,
      value: option.value,
      label: option.label || option.textContent.trim(),
      detail: option.title || undefined,
      group: group?.label,
      disabled: option.disabled || Boolean(group?.disabled),
    };
  });
}

function open(target, typed = "") {
  if (choices.isOpen) choices.close();
  select = target;
  (target.closest("dialog") ?? document.body).append(choices.scrim, choices.popover);
  target.closest("dialog")?.addEventListener("close", closeList);
  const label = labelOf(target);
  if (label) choices.search.setAttribute("aria-label", `Search ${label.toLocaleLowerCase()}`);
  else choices.search.removeAttribute("aria-label");
  choices.open(target, choicesOf(target), target.value, { floating: true, typed });
}

const OPEN_KEYS = new Set(["Enter", " ", "ArrowDown", "ArrowUp", "F4"]);

export function installSelectSearch(root = document) {
  root.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const target = searchable(event.target);
    if (!target) return;
    event.preventDefault();
    target.focus();
    if (choices.isOpen && select === target) choices.close();
    else open(target);
  }, true);
  // A tap opens the list on touchend, after the finger stayed put, so a scroll over a select does not.
  root.addEventListener("touchstart", (event) => {
    touchStart = searchable(event.target) ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  }, { capture: true, passive: true });
  root.addEventListener("touchend", (event) => {
    const target = searchable(event.target);
    if (!target || !touchStart) return;
    const touch = event.changedTouches[0];
    const moved = Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) > 10;
    touchStart = null;
    if (moved) return;
    event.preventDefault();
    open(target);
  }, { capture: true, passive: false });
  root.addEventListener("keydown", (event) => {
    const target = searchable(event.target);
    if (!target || event.target !== target || event.ctrlKey || event.metaKey) return;
    const typing = event.key.length === 1 && event.key !== " " && !event.altKey;
    if (!typing && !OPEN_KEYS.has(event.key)) return;
    event.preventDefault();
    open(target, typing ? event.key : "");
  }, true);
  root.addEventListener("pointerdown", (event) => {
    if (!choices.isOpen || choices.popover.contains(event.target) || event.target === choices.scrim || event.target === select) return;
    choices.close();
  }, true);
}
