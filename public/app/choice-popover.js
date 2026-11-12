import { rankChoices } from "./fuzzy.js";

/**
 * The list behind every dropdown: a search box over the choices, filtered as you type with
 * fuzzy matching ("op55" finds Opus 5.5) and the matched letters marked. Arrow keys move,
 * Enter chooses, Escape closes only the list. On a phone it rises as a sheet from the bottom
 * and leaves the keyboard down until the search box is tapped.
 *
 * Choices are `{ value, label, detail?, keywords?, group?, disabled? }`.
 */
export const phoneSheet = matchMedia("(max-width: 700px)");

/** `text` with the letters at `hits` wrapped in <mark>. */
export function markedText(text, hits) {
  const fragment = document.createDocumentFragment();
  if (!hits.length) { fragment.append(text); return fragment; }
  const marked = new Set(hits);
  let run = "";
  let runMarked = false;
  const flush = () => {
    if (!run) return;
    if (runMarked) { const mark = document.createElement("mark"); mark.textContent = run; fragment.append(mark); }
    else fragment.append(run);
    run = "";
  };
  [...text].forEach((character, index) => {
    if (marked.has(index) !== runMarked) { flush(); runMarked = marked.has(index); }
    run += character;
  });
  flush();
  return fragment;
}

/**
 * Builds the list. `container` holds it; with `fixed`, it floats beside `anchor` in the
 * viewport, which a list inside a clipped or scrolled area needs. `onChoose(choice)` runs on
 * a choice; `onClose({ focusAnchor })` after the list closes. A `detached` list lives away from
 * its anchor in the page, so Tab returns to the anchor instead of moving past the list.
 */
export function createChoicePopover({ id, testid, label, placeholder = "Search", emptyText = "No matches", optionTestid = `${testid}-option`, listTestid = `${testid}-options`, icon, detached = false, onChoose, onClose }) {
  const popover = document.createElement("div");
  popover.className = "searchable-select-popover"; popover.hidden = true;
  const search = document.createElement("input");
  search.type = "search"; search.role = "combobox"; search.autocomplete = "off"; search.spellcheck = false;
  search.placeholder = placeholder; search.dataset.testid = `${testid}-search`;
  search.setAttribute("aria-autocomplete", "list"); search.setAttribute("aria-expanded", "true");
  const list = document.createElement("div");
  list.id = `${id}Options`; list.className = "searchable-select-options"; list.role = "listbox"; list.dataset.testid = listTestid;
  search.setAttribute("aria-controls", list.id);
  if (label) search.setAttribute("aria-label", `Search ${label.toLocaleLowerCase()}`);
  popover.append(search, list);
  const scrim = document.createElement("div");
  scrim.className = "choice-scrim"; scrim.hidden = true;
  scrim.addEventListener("pointerdown", (event) => { event.preventDefault(); close({ focusAnchor: true }); });

  let choices = [];
  let value = "";
  let anchor = null;
  let fixed = false;
  let active = -1;

  function place() {
    if (popover.classList.contains("sheet")) { popover.style.cssText = ""; return; }
    if (!fixed) return;
    const rect = anchor.getBoundingClientRect();
    const gap = 4;
    const below = window.innerHeight - rect.bottom - gap;
    const above = below < popover.offsetHeight && rect.top - gap > below;
    const width = Math.max(rect.width, 240);
    Object.assign(popover.style, {
      position: "fixed", right: "auto", width: `${width}px`,
      left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
      top: above ? "auto" : `${rect.bottom + gap}px`,
      bottom: above ? `${window.innerHeight - rect.top + gap}px` : "auto",
    });
  }
  const reposition = () => place();

  function highlight(index) {
    const items = [...list.querySelectorAll("[role='option']:not(:disabled)")];
    active = items.length ? (index + items.length) % items.length : -1;
    list.querySelectorAll("[role='option']").forEach((item) => item.classList.toggle("active", item === items[active]));
    if (active < 0) { search.removeAttribute("aria-activedescendant"); return; }
    search.setAttribute("aria-activedescendant", items[active].id);
    items[active].scrollIntoView({ block: "nearest" });
  }

  function render() {
    const typed = search.value.trim();
    const rows = rankChoices(typed, choices);
    const nodes = [];
    let group = null;
    rows.forEach(({ choice, hits }, index) => {
      if (!typed && choice.group && choice.group !== group) {
        group = choice.group;
        const heading = document.createElement("div");
        heading.className = "choice-group"; heading.role = "presentation"; heading.textContent = group;
        nodes.push(heading);
      }
      const item = document.createElement("button");
      item.type = "button"; item.role = "option"; item.id = `${id}Option${index}`; item.tabIndex = -1;
      item.className = "searchable-select-option"; item.dataset.testid = optionTestid; item.dataset.value = choice.value;
      item.disabled = Boolean(choice.disabled);
      item.setAttribute("aria-selected", String(choice.value === value));
      if (icon) item.append(icon(choice.value));
      const name = document.createElement("span");
      name.className = "searchable-select-option-label";
      name.append(markedText(choice.label, hits));
      item.append(name);
      if (choice.detail && choice.detail !== choice.label) {
        const detail = document.createElement("span"); detail.className = "searchable-select-option-detail"; detail.textContent = choice.detail; item.append(detail);
      }
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => choose(choice));
      nodes.push(item);
    });
    list.replaceChildren(...nodes);
    if (!rows.length) list.textContent = emptyText;
    const enabled = rows.filter((row) => !row.choice.disabled);
    const current = enabled.findIndex((row) => row.choice.value === value);
    highlight(typed || current < 0 ? 0 : current);
    place();
  }

  function choose(choice) {
    close({ focusAnchor: true });
    onChoose(choice);
  }

  function open(nextAnchor, nextChoices, nextValue, { floating = false, typed = "" } = {}) {
    anchor = nextAnchor; choices = nextChoices; value = nextValue; fixed = floating;
    const sheet = phoneSheet.matches;
    popover.classList.toggle("sheet", sheet);
    scrim.hidden = !sheet;
    search.value = typed;
    popover.hidden = false;
    window.addEventListener("resize", reposition); window.addEventListener("scroll", reposition, true);
    render();
    // On a phone the keyboard would cover the list; it rises only when the search box is tapped.
    if (!sheet || typed) search.focus();
  }

  function close({ focusAnchor = false } = {}) {
    if (popover.hidden) return;
    popover.hidden = true; scrim.hidden = true; search.removeAttribute("aria-activedescendant");
    window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true);
    onClose?.({ focusAnchor });
  }

  search.addEventListener("input", render);
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      highlight(active + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      list.querySelectorAll("[role='option']:not(:disabled)")[active]?.click();
    } else if (event.key === "Escape") {
      // Keep the dialog open; only the list closes.
      event.preventDefault(); event.stopPropagation();
      close({ focusAnchor: true });
    } else if (event.key === "Tab") {
      if (detached) event.preventDefault();
      close({ focusAnchor: detached });
    }
  });

  return {
    popover,
    scrim,
    search,
    list,
    open,
    close,
    get isOpen() { return !popover.hidden; },
    /** New choices or value while open, as when a list loads late. */
    refresh(nextChoices, nextValue) { choices = nextChoices; value = nextValue; if (!popover.hidden) render(); },
  };
}
