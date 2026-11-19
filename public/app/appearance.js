import { setTheme } from "./shell.js";

// Appearance (theme and text sizes) is per browser, not per account: a big screen wants larger text, a laptop does not,
// and a phone's theme must not change the desktop's.
const APPEARANCE_STORAGE_KEY = "jointBobAppearance";

export const THEMES = [
  // Built-in Paper · Editorial palettes
  { id: "light", label: "Light", base: "light", group: "builtin", page: "#f2ebdf", card: "#fffbf4", accent: "#2f6b4f", color: "#f2ebdf" },
  { id: "sepia", label: "Sepia", base: "light", group: "builtin", page: "#e4d8c1", card: "#fbf5e8", accent: "#2f6b4f", color: "#efe6d4" },
  { id: "dark", label: "Dark", base: "dark", group: "builtin", page: "#171412", card: "#2e2925", accent: "#7fcf9f", color: "#171412" },
  { id: "midnight", label: "Midnight", base: "dark", group: "builtin", page: "#0e1320", card: "#212b44", accent: "#7fcf9f", color: "#0e1320" },
  { id: "graphite", label: "Graphite", base: "dark", group: "builtin", page: "#1a1a1b", card: "#313134", accent: "#7fcf9f", color: "#1a1a1b" },
  // Classic Dark palettes (VS Code)
  { id: "dracula", label: "Dracula", base: "dark", group: "dark", page: "#1e1f29", card: "#282a36", accent: "#bd93f9", color: "#1e1f29" },
  { id: "tokyo-night", label: "Tokyo Night", base: "dark", group: "dark", page: "#16161e", card: "#1a1b26", accent: "#7aa2f7", color: "#16161e" },
  { id: "catppuccin-mocha", label: "Catppuccin", base: "dark", group: "dark", page: "#181825", card: "#1e1e2e", accent: "#cba6f7", color: "#181825" },
  { id: "nord", label: "Nord", base: "dark", group: "dark", page: "#242933", card: "#2e3440", accent: "#88c0d0", color: "#242933" },
  { id: "one-dark-pro", label: "One Dark", base: "dark", group: "dark", page: "#21252b", card: "#282c34", accent: "#61afef", color: "#21252b" },
  { id: "gruvbox-dark", label: "Gruvbox", base: "dark", group: "dark", page: "#1d2021", card: "#282828", accent: "#fabd2f", color: "#1d2021" },
  { id: "monokai-pro", label: "Monokai", base: "dark", group: "dark", page: "#221f22", card: "#2d2a2e", accent: "#ffd866", color: "#221f22" },
  { id: "solarized-dark", label: "Solarized", base: "dark", group: "dark", page: "#00212b", card: "#002b36", accent: "#2aa198", color: "#00212b" },
  { id: "rose-pine", label: "Rosé Pine", base: "dark", group: "dark", page: "#191724", card: "#1f1d2e", accent: "#ebbcba", color: "#191724" },
  { id: "kanagawa", label: "Kanagawa", base: "dark", group: "dark", page: "#16161d", card: "#1f1f28", accent: "#7e9cd8", color: "#16161d" },
  // Classic Light palettes (VS Code)
  { id: "catppuccin-latte", label: "Latte", base: "light", group: "light", page: "#e6e9ef", card: "#eff1f5", accent: "#8839ef", color: "#e6e9ef" },
  { id: "solarized-light", label: "Solarized Lt", base: "light", group: "light", page: "#eee8d5", card: "#fdf6e3", accent: "#268bd2", color: "#eee8d5" },
  { id: "github-light", label: "GitHub Lt", base: "light", group: "light", page: "#f6f8fa", card: "#ffffff", accent: "#0969da", color: "#f6f8fa" },
  { id: "gruvbox-light", label: "Gruvbox Lt", base: "light", group: "light", page: "#ebdbb2", card: "#fbf1c7", accent: "#b57614", color: "#ebdbb2" },
];

const THEME_GROUPS = [
  { id: "builtin", label: "Built-in" },
  { id: "dark", label: "Classic Dark" },
  { id: "light", label: "Classic Light" },
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
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && theme.color) meta.content = theme.color;
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

function themeChoiceButton(label, testId, pressed, swatchBg, swatchAccent, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost appearance-theme-choice";
  button.dataset.testid = testId;
  button.setAttribute("aria-pressed", String(pressed));
  const swatch = document.createElement("span");
  swatch.className = "appearance-theme-swatch";
  swatch.style.setProperty("--swatch-bg", swatchBg);
  swatch.style.setProperty("--swatch-accent", swatchAccent);
  swatch.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "appearance-theme-name";
  name.textContent = label;
  button.append(swatch, name);
  button.addEventListener("click", onClick);
  return button;
}

function renderThemes() {
  const active = currentThemeId();
  // Grouped choices matching Settings › Appearance: Built-in (System first), Classic Dark, Classic Light.
  const choose = (id) => () => {
    settings.theme = id;
    applyTheme();
    save();
    renderThemes();
    renderAccountAppearance();
  };
  themeRow.replaceChildren(...THEME_GROUPS.map((group) => {
    const section = document.createElement("div");
    section.className = "appearance-theme-group";
    const heading = document.createElement("div");
    heading.className = "appearance-theme-group-label";
    heading.textContent = group.label;
    const grid = document.createElement("div");
    grid.className = "appearance-theme-grid";
    const buttons = THEMES
      .filter((theme) => theme.group === group.id)
      .map((theme) => themeChoiceButton(
        theme.label,
        `appearance-theme-${theme.id}`,
        Boolean(settings.theme) && theme.id === active,
        theme.card,
        theme.accent,
        choose(theme.id),
      ));
    if (group.id === "builtin") {
      buttons.unshift(themeChoiceButton("System", "appearance-theme-system", !settings.theme, "#fffbf4", "#211d1a", choose("")));
    }
    grid.append(...buttons);
    section.append(heading, grid);
    return section;
  }));
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

/* ---- Settings › Account › Appearance: theme preview tiles, and text size. ---- */

/** Each tile shows the theme's page, card and accent colours; System splits light and dark. */
export const THEME_TILES = [
  { id: "", key: "system", label: "System", page: "#fffbf4", card: "#211d1a" },
  ...THEMES.map(({ id, label, page, card, accent }) => ({ id, key: id, label, page, card, accent })),
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
  if (tile.accent) preview.style.setProperty("--tile-accent", tile.accent);
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
