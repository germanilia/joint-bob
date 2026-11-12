import { fuzzyScore } from "./fuzzy.js";

const MAX_RESULTS = 8;
const MAX_LABEL_LENGTH = 160;

/**
 * Searches every settings section by name: tab names, field labels, legends and headings.
 * Typing filters the list of sections in place to the ones whose name matches; settings found
 * inside sections (a field, a group, a section's own tab) are listed under them, so a search finds
 * a setting before the user knows which section holds it.
 * `isAvailable(tab)` hides tabs this account can't open; `onPick(tab, element, entry)` opens the match.
 */
export function createSettingsSearch({ input, results, tabs, panels, isAvailable, onPick, getExtraEntries = () => [] }) {
  const sidebar = input.closest(".settings-sidebar");
  const groups = [...new Set(tabs.map((tab) => tab.closest(".settings-group")).filter(Boolean))];
  /** What the arrows walk: the matching section rows, then the settings found inside sections. */
  let items = [];
  let active = 0;

  const tabName = (tab) => tab.querySelector(".settings-tab-label")?.textContent.trim() ?? tab.textContent.trim();
  const tabIcon = (tab) => tab.querySelector(".settings-tab-icon");
  /** A label's own words: a label wrapping a dropdown would otherwise read out every option. */
  const ownText = (element) => {
    if (!element.querySelector("select, textarea, button")) return element.textContent.replace(/\s+/g, " ").trim();
    const copy = element.cloneNode(true);
    for (const control of copy.querySelectorAll("select, textarea, button")) control.remove();
    return copy.textContent.replace(/\s+/g, " ").trim();
  };

  function index() {
    const entries = [];
    for (const tab of tabs) {
      if (!isAvailable(tab)) continue;
      const name = tabName(tab);
      entries.push({ tab, element: tab, title: name, section: "", key: name, search: name });
      const panel = panels.find((item) => item.id === `settingsPanel-${tab.dataset.settingsTab}`);
      if (!panel) continue;
      // A section's own tabs are found too, so "serving" finds Relay › Serving.
      // A row that names itself in bold instead of a label (Account › Theme, Text size) is found by that name.
      for (const element of panel.querySelectorAll("legend, label, h2, h3, [role='tab'], .settings-row-text > strong")) {
        // Skip anything the panel itself hides (admin-only rows, collapsed sections), and the section's head.
        if (element.closest("[hidden]:not(.settings-panel), .settings-section-head")) continue;
        const title = ownText(element);
        if (!title || title.length > MAX_LABEL_LENGTH) continue;
        const section = element.closest("fieldset")?.querySelector("legend")?.textContent.replace(/\s+/g, " ").trim() ?? "";
        // A section's own tab reads as where it leads: "Relay › Serving".
        const key = element.matches("[role='tab']") ? `${name} › ${title}` : `${name} › ${section || name}`;
        entries.push({ tab, element, title, section, key, search: `${title} ${section} ${name}` });
      }
    }
    entries.push(...getExtraEntries());
    return entries;
  }

  /** Every match, best first. A section is found by its own name only. */
  function search(query) {
    const needle = query.trim();
    if (!needle) return [];
    const scored = [];
    for (const entry of index()) {
      // A title match outranks a match on the section or tab it sits in.
      const title = fuzzyScore(needle, entry.title);
      const context = entry.element === entry.tab ? null : fuzzyScore(needle, entry.search);
      const score = title !== null ? title + 100 : context;
      if (score !== null) scored.push({ ...entry, score });
    }
    return scored.sort((left, right) => right.score - left.score);
  }

  function highlight(position) {
    active = items.length ? (position + items.length) % items.length : 0;
    items.forEach((item, at) => item.row.classList.toggle("active", at === active));
    items[active]?.row.scrollIntoView({ block: "nearest" });
  }

  /** The whole list again: no row filtered out, nothing marked. */
  function showAll() {
    for (const tab of tabs) { tab.removeAttribute("data-search-miss"); tab.classList.remove("active"); }
    for (const group of groups) group.removeAttribute("data-search-miss");
    sidebar?.removeAttribute("data-searching");
    results.hidden = true;
    results.replaceChildren();
    items = [];
    active = 0;
  }

  function resultRow(entry) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "settings-search-result";
    row.setAttribute("role", "option");
    row.dataset.testid = "settings-search-result";
    const icon = tabIcon(entry.tab)?.cloneNode(true);
    if (icon) row.append(icon);
    const text = document.createElement("span");
    text.className = "settings-search-text";
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const path = document.createElement("small");
    path.textContent = entry.key;
    text.append(title, path);
    row.append(text);
    // Picking on the press keeps the search box focused, so the list does not jump under the finger.
    row.addEventListener("mousedown", (event) => { event.preventDefault(); pick(items.findIndex((item) => item.row === row)); });
    return row;
  }

  function render() {
    const query = input.value.trim();
    if (!query) { showAll(); return; }
    const found = search(query);
    const sections = new Map(found.filter((entry) => entry.element === entry.tab).map((entry) => [entry.tab, entry]));
    const inside = found.filter((entry) => entry.element !== entry.tab).slice(0, MAX_RESULTS);

    sidebar?.setAttribute("data-searching", "true");
    for (const tab of tabs) { tab.toggleAttribute("data-search-miss", !sections.has(tab)); tab.classList.remove("active"); }
    for (const group of groups) group.toggleAttribute("data-search-miss", !tabs.some((tab) => sections.has(tab) && group.contains(tab)));

    results.replaceChildren();
    results.hidden = false;
    results.dataset.sections = String(sections.size);
    if (!found.length) {
      const empty = document.createElement("p");
      empty.className = "settings-search-empty";
      empty.textContent = `No settings match “${query}”`;
      results.append(empty);
    } else if (inside.length) {
      const label = document.createElement("p");
      label.className = "settings-search-label";
      label.textContent = "In sections";
      results.append(label);
    } else results.hidden = true;

    // Rows in the order they show: the sections as the list has them, then the settings inside.
    items = tabs.filter((tab) => sections.has(tab)).map((tab) => ({ row: tab, entry: sections.get(tab) }));
    for (const entry of inside) {
      const row = resultRow(entry);
      results.append(row);
      items.push({ row, entry });
    }
    // Enter takes the best match, wherever it shows.
    const best = items.reduce((top, item, at) => (top < 0 || item.entry.score > items[top].entry.score ? at : top), -1);
    highlight(Math.max(best, 0));
  }

  function pick(position) {
    const entry = items[position]?.entry;
    if (!entry) return;
    input.value = "";
    showAll();
    onPick(entry.tab, entry.element, entry);
  }

  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    const searching = Boolean(input.value.trim());
    if (event.key === "ArrowDown" && !searching) {
      // Nothing typed: the arrow steps into the list, where the arrows walk the sections.
      const current = tabs.find((tab) => tab.getAttribute("aria-selected") === "true" && isAvailable(tab)) ?? tabs.find(isAvailable);
      if (current) { event.preventDefault(); current.focus(); }
    } else if (event.key === "ArrowDown") { event.preventDefault(); highlight(active + 1); }
    else if (event.key === "ArrowUp" && searching) { event.preventDefault(); highlight(active - 1); }
    else if (event.key === "Enter") { event.preventDefault(); pick(active); }
    else if (event.key === "Escape" && searching) { event.stopPropagation(); event.preventDefault(); input.value = ""; showAll(); }
  });

  return {
    clear() { input.value = ""; showAll(); },
    focus() { input.focus(); input.select(); },
  };
}
