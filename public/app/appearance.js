import { setTheme } from "./shell.js";

// Appearance (theme and text sizes) is per browser, not per account: a big screen wants larger text, a laptop does not,
// and a phone's theme must not change the desktop's.
const APPEARANCE_STORAGE_KEY = "jointBobAppearance";

export const THEMES = [
  { id: "light", label: "Light", base: "light" },
  { id: "dark", label: "Dark", base: "dark" },
  { id: "midnight", label: "Midnight", base: "dark" },
  { id: "graphite", label: "Graphite", base: "dark" },
  { id: "sepia", label: "Sepia", base: "light" },
];

// The ids stay as stored; on the desktop workspace "projects" sizes the left column (places, groups, the project picker),
// "conversations" a project's conversation list in it and the Show all lists, "activity" the details column.
export const SECTIONS = [
  { id: "projects", label: "Left column" },
  { id: "conversations", label: "Conversation lists" },
  { id: "chat", label: "Conversation" },
  { id: "activity", label: "Details column (on top of conversation)" },
  { id: "headers", label: "Headers" },
];

export const PRESETS = [
  { id: "default", label: "Default", global: 1 },
  { id: "large", label: "Large", global: 1.15 },
  { id: "larger", label: "Larger", global: 1.3 },
  { id: "huge", label: "Huge", global: 1.5 },
];

const MIN_SCALE = 0.8;
const MAX_SCALE = 2;
const STEP = 0.05;

const defaults = () => ({ theme: "", global: 1, sections: Object.fromEntries(SECTIONS.map((section) => [section.id, 1])) });

function clampScale(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  // Rounded after snapping, so 23 steps of 0.05 is 1.15 and not 1.1500000000000001.
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(Math.round(number / STEP) * STEP * 1e6) / 1e6));
}

function load() {
  const stored = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) || "null");
  const settings = defaults();
  if (!stored) return settings;
  settings.theme = THEMES.some((theme) => theme.id === stored.theme) ? stored.theme : "";
  settings.global = clampScale(stored.global);
  for (const section of SECTIONS) settings.sections[section.id] = clampScale(stored.sections?.[section.id]);
  return settings;
}

let settings = load();

function save() {
  localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(settings));
}

/** Scale vars on the root; styles.css applies them as `zoom` on each section. */
function applyScales() {
  const root = document.documentElement.style;
  // Panels carry the global size; the activity pane sits inside the conversation and headers
  // inside their panel, so those two multiply on top of it.
  root.setProperty("--ui-zoom-projects", String(settings.global * settings.sections.projects));
  root.setProperty("--ui-zoom-conversations", String(settings.global * settings.sections.conversations));
  root.setProperty("--ui-zoom-chat", String(settings.global * settings.sections.chat));
  root.setProperty("--ui-zoom-activity", String(settings.sections.activity));
  root.setProperty("--ui-zoom-headers", String(settings.sections.headers));
}

const systemDark = matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
  const theme = THEMES.find((item) => item.id === settings.theme);
  if (!theme) {
    // System: no stored theme, so the device's light or dark setting decides, as at boot.
    delete document.documentElement.dataset.palette;
    setTheme(systemDark.matches ? "dark" : "light");
    return;
  }
  setTheme(theme.base);
  if (theme.id === theme.base) delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = theme.id;
}

function currentThemeId() {
  const root = document.documentElement.dataset;
  return root.palette && THEMES.some((theme) => theme.id === root.palette && theme.base === root.theme) ? root.palette : root.theme;
}

const dialog = document.querySelector("#appearanceDialog");
const themeRow = dialog.querySelector("#appearanceThemes");
const presetRow = dialog.querySelector("#appearancePresets");
const sectionList = dialog.querySelector("#appearanceSections");
const globalLabel = dialog.querySelector("#appearanceGlobalValue");

function percent(scale) {
  return `${Math.round(scale * 100)}%`;
}

function choiceButton(label, testId, pressed, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.textContent = label;
  button.dataset.testid = testId;
  button.setAttribute("aria-pressed", String(pressed));
  button.addEventListener("click", onClick);
  return button;
}

function sectionSlider(section) {
  const label = document.createElement("label");
  label.className = "appearance-slider";
  const name = document.createElement("span");
  name.textContent = section.label;
  const value = document.createElement("output");
  value.textContent = percent(settings.sections[section.id]);
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(MIN_SCALE);
  input.max = String(MAX_SCALE);
  input.step = String(STEP);
  input.value = String(settings.sections[section.id]);
  input.dataset.testid = `appearance-${section.id}-slider`;
  input.addEventListener("input", () => {
    settings.sections[section.id] = clampScale(input.value);
    value.textContent = percent(settings.sections[section.id]);
    applyScales();
    save();
    renderPresets();
  });
  label.append(name, value, input);
  return label;
}

function renderThemes() {
  const active = currentThemeId();
  // The same six choices as Settings › Account: System (no stored theme, follows the device) first.
  const choose = (id) => () => {
    settings.theme = id;
    applyTheme();
    save();
    renderThemes();
    renderAccountAppearance();
  };
  themeRow.replaceChildren(
    choiceButton("System", "appearance-theme-system", !settings.theme, choose("")),
    ...THEMES.map((theme) => choiceButton(theme.label, `appearance-theme-${theme.id}`, Boolean(settings.theme) && theme.id === active, choose(theme.id))),
  );
}

function renderPresets() {
  const sectionsDefault = SECTIONS.every((section) => settings.sections[section.id] === 1);
  globalLabel.textContent = percent(settings.global);
  presetRow.replaceChildren(...PRESETS.map((preset) => choiceButton(preset.label, `appearance-preset-${preset.id}`, sectionsDefault && preset.global === settings.global, () => {
    settings = { ...settings, global: preset.global, sections: defaults().sections };
    applyScales();
    save();
    render();
  })));
  renderAccountAppearance();
}

function render() {
  renderThemes();
  renderPresets();
  sectionList.replaceChildren(...SECTIONS.map(sectionSlider));
}

/* ---- Settings › Account › Appearance: the six themes as tiles that preview them, and text size. ---- */

/** Each tile shows the theme's page and card colours, as the mock does; System splits light and dark. */
export const THEME_TILES = [
  { id: "", key: "system", label: "System", page: "#fffbf4", card: "#211d1a" },
  { id: "light", key: "light", label: "Light", page: "#f2ebdf", card: "#fffbf4" },
  { id: "sepia", key: "sepia", label: "Sepia", page: "#e4d8c1", card: "#fbf5e8" },
  { id: "dark", key: "dark", label: "Dark", page: "#171412", card: "#2e2925" },
  { id: "midnight", key: "midnight", label: "Midnight", page: "#0e1320", card: "#212b44" },
  { id: "graphite", key: "graphite", label: "Graphite", page: "#1a1a1b", card: "#313134" },
];

const accountTiles = document.querySelector("#settingsThemeTiles");
const accountPresets = document.querySelector("#settingsTextSizePresets");
const accountAreas = document.querySelector("#settingsTextSizeAreas");

function chooseTheme(id) {
  settings.theme = id;
  applyTheme();
  save();
  render();
}

function themeTile(tile) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "theme-tile";
  button.dataset.testid = `settings-theme-${tile.key}`;
  button.setAttribute("role", "radio");
  const chosen = settings.theme === tile.id;
  button.setAttribute("aria-checked", String(chosen));
  button.tabIndex = chosen ? 0 : -1;
  const preview = document.createElement("span");
  preview.className = "theme-tile-preview";
  preview.style.setProperty("--tile-page", tile.page);
  preview.style.setProperty("--tile-card", tile.card);
  preview.setAttribute("aria-hidden", "true");
  button.append(preview, tile.label);
  button.addEventListener("click", () => chooseTheme(tile.id));
  // A radio group: the arrows move the choice.
  button.addEventListener("keydown", (event) => {
    const step = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = THEME_TILES[(THEME_TILES.indexOf(tile) + step + THEME_TILES.length) % THEME_TILES.length];
    chooseTheme(next.id);
    accountTiles.querySelector(`[data-testid="settings-theme-${next.key}"]`)?.focus();
  });
  return button;
}

function accountSlider(section) {
  const slider = sectionSlider(section);
  slider.querySelector("input").dataset.testid = `settings-text-size-${section.id}`;
  return slider;
}

function renderAccountAppearance() {
  if (!accountTiles) return;
  accountTiles.replaceChildren(...THEME_TILES.map(themeTile));
  // The phone's Settings list names the theme in use on its Appearance row.
  const listValue = document.querySelector("#settingsAppearanceValue");
  if (listValue) listValue.textContent = themeLabel();
  const sectionsDefault = SECTIONS.every((section) => settings.sections[section.id] === 1);
  accountPresets.replaceChildren(...PRESETS.map((preset) => {
    const button = choiceButton(preset.label, `settings-text-size-preset-${preset.id}`, sectionsDefault && preset.global === settings.global, () => {
      settings = { ...settings, global: preset.global, sections: defaults().sections };
      applyScales();
      save();
      render();
    });
    button.className = "settings-segment";
    return button;
  }));
  // Typing in a slider re-renders only its own label, so a drag is not cut short.
  if (!accountAreas.contains(document.activeElement)) accountAreas.replaceChildren(...SECTIONS.map(accountSlider));
}

/** The chosen theme's name: "System" while none is stored. */
export function themeLabel() {
  return THEMES.find((theme) => theme.id === settings.theme)?.label ?? "System";
}

export function openAppearance() {
  render();
  dialog.showModal();
}
const open = openAppearance;

const logo = document.querySelector("#brandMark");
logo.addEventListener("click", open);
logo.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  open();
});
// System follows the device while it is chosen, also when the device switches at sunset.
systemDark.addEventListener("change", () => { if (!settings.theme) applyTheme(); });
dialog.querySelector("#appearanceCloseButton").addEventListener("click", () => dialog.close());
dialog.querySelector("#appearanceResetButton").addEventListener("click", () => {
  settings = defaults();
  applyTheme();
  applyScales();
  save();
  render();
});

/** The display settings and what they allow, for Bob's display agent, which may change them from Bob's chat. */
export function appearanceContext() {
  return {
    settings: structuredClone(settings),
    themes: THEMES.map(({ id, label }) => ({ id, label })),
    sections: SECTIONS.map(({ id, label }) => ({ id, label })),
    scale: { min: MIN_SCALE, max: MAX_SCALE, step: STEP },
  };
}

/** Applies display settings chosen elsewhere (Bob's display agent, or its Undo), kept to what this page allows, as the dialog would. */
export function applyAppearance(next) {
  settings = {
    theme: THEMES.some((theme) => theme.id === next.theme) ? next.theme : "",
    global: clampScale(next.global),
    sections: Object.fromEntries(SECTIONS.map((section) => [section.id, clampScale(next.sections?.[section.id])])),
  };
  applyTheme();
  applyScales();
  save();
  render();
}

applyTheme();
applyScales();

renderAccountAppearance();
