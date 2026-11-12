import { createChoicePopover } from "./choice-popover.js";

/**
 * A dropdown with a search box. The closed control looks and acts like a select: it shows the
 * current choice behind a chevron and cannot be typed into. Opening it shows the shared choice
 * list (choice-popover.js): typing narrows it with fuzzy matching, and only a listed option can
 * be chosen.
 *
 * Options are `{ value, label, detail?, keywords?, group?, disabled? }`; the label matches
 * loosely, the value, detail and keywords as text.
 */
export function createSearchableSelect({ id, testid, label, prompt = "Choose…", placeholder = "Search", emptyText = "No matches", optionTestid = `${testid}-option`, listTestid = `${testid}-options`, icon }) {
  const root = document.createElement("div");
  root.className = "searchable-select";
  const trigger = document.createElement("button");
  trigger.type = "button"; trigger.id = id; trigger.className = "searchable-select-trigger";
  trigger.dataset.testid = testid; trigger.dataset.value = "";
  trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
  if (label) trigger.setAttribute("aria-label", label);

  let options = [];
  const listeners = [];
  const choices = createChoicePopover({
    id, testid, label, placeholder, emptyText, optionTestid, listTestid, icon,
    onChoose(option) {
      const changed = option.value !== trigger.dataset.value;
      trigger.dataset.value = option.value;
      showSelected();
      if (changed) for (const listener of listeners) listener(option.value);
      // For a form around it that saves as it changes (Settings): a choice the person made.
      if (changed) trigger.dispatchEvent(new CustomEvent("choice-change", { bubbles: true, detail: { value: option.value } }));
    },
    onClose({ focusAnchor }) {
      trigger.setAttribute("aria-expanded", "false");
      if (focusAnchor) trigger.focus();
    },
  });
  trigger.setAttribute("aria-controls", choices.list.id);
  root.append(trigger, choices.scrim, choices.popover);

  const selected = () => options.find((option) => option.value === trigger.dataset.value);
  function showSelected() {
    const text = selected()?.label ?? trigger.dataset.value;
    trigger.replaceChildren(...(text && icon ? [icon(trigger.dataset.value)] : []), document.createTextNode(text || prompt));
    trigger.classList.toggle("empty", !text);
  }

  function open(typed = "") {
    trigger.setAttribute("aria-expanded", "true");
    // Dialogs, focus menus, and Settings cards clip and scroll, so there the list floats beside the trigger.
    const floating = Boolean(root.closest("dialog, #focusControls, .provider-profiles"));
    choices.open(trigger, options, trigger.dataset.value, { floating, typed });
  }

  trigger.addEventListener("click", () => (choices.isOpen ? choices.close() : open()));
  trigger.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp"].includes(event.key) && !choices.isOpen) { event.preventDefault(); open(); }
    // A phone's sheet leaves focus on the trigger until its search box is tapped; Escape still closes only the list.
    if (event.key === "Escape" && choices.isOpen) { event.preventDefault(); event.stopPropagation(); choices.close(); }
  });
  root.addEventListener("focusout", (event) => { if (!root.contains(event.relatedTarget)) choices.close(); });

  showSelected();
  return {
    root,
    trigger,
    get value() { return trigger.dataset.value; },
    /** Replaces the options. The current choice is kept, so a value missing from them must be listed by the caller to stay visible. */
    setOptions(next) { options = next; showSelected(); choices.refresh(options, trigger.dataset.value); },
    setValue(value) { trigger.dataset.value = value; showSelected(); },
    get disabled() { return trigger.disabled; },
    set disabled(value) { trigger.disabled = value; if (value) choices.close(); },
    onChange(listener) { listeners.push(listener); },
  };
}
