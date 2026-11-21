import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

// The Paper look (docs/superpowers/specs/2026-11-10-ui-redo-paper-design.md) is one stylesheet that
// loads last and resets the app's design tokens per theme, with its fonts shipped from the app.
const text = (path: string) => readFile(path, "utf8");
const FONT_FILES = ["/fonts/dm-sans.woff2", "/fonts/young-serif.woff2"];

test("the Paper stylesheet loads after every other stylesheet", async () => {
  const page = await text("public/index.html");
  const sheets = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(sheets.at(-1), "/paper.css");
});

test("Paper fonts ship with their licences", async () => {
  for (const file of [...FONT_FILES, "/fonts/dm-sans-OFL.txt", "/fonts/young-serif-OFL.txt"]) await access(`public${file}`);
  const sheet = await text("public/paper.css");
  assert.match(sheet, /@font-face\s*\{[^}]*font-family:\s*"DM Sans"[^}]*url\("\/fonts\/dm-sans\.woff2"\)/);
  assert.match(sheet, /@font-face\s*\{[^}]*font-family:\s*"Young Serif"[^}]*url\("\/fonts\/young-serif\.woff2"\)/);
});

test("the worker caches the Paper files", async () => {
  const worker = await text("public/sw.js");
  const shell = JSON.parse(/const APP_SHELL = (\[[^\n]+\]);/.exec(worker)![1]) as string[];
  for (const file of ["/paper.css", ...FONT_FILES]) assert.ok(shell.includes(file), `${file} is missing from APP_SHELL`);
});

test("Paper sets the tokens for every theme", async () => {
  const sheet = await text("public/paper.css");
  const assistantSheet = await text("public/assistant/assistant.css");
  const assistantTheme = await text("public/assistant/theme.js");
  const darkPalettes = [
    "midnight",
    "graphite",
    "dracula",
    "tokyo-night",
    "catppuccin-mocha",
    "nord",
    "one-dark-pro",
    "vscode-dark",
    "github-dark",
    "night-owl",
    "palenight",
    "synthwave",
    "gruvbox-dark",
    "monokai-pro",
    "solarized-dark",
    "rose-pine",
    "kanagawa",
  ];
  const lightPalettes = [
    "sepia",
    "vscode-light",
    "catppuccin-latte",
    "solarized-light",
    "github-light",
    "gruvbox-light",
  ];
  const selectors = [
    ":root",
    ':root[data-theme="dark"]',
    ...darkPalettes.map((id) => `:root[data-theme="dark"][data-palette="${id}"]`),
    ...lightPalettes.map((id) => `:root[data-theme="light"][data-palette="${id}"]`),
  ];
  for (const selector of selectors) {
    const block = new RegExp(`(^|\\n)${selector.replace(/[[\]"]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(sheet);
    assert.ok(block, `no token block for ${selector}`);
    for (const token of ["--bg", "--panel", "--header", "--surface", "--field", "--line", "--text", "--muted", "--accent", "--btn-bg", "--btn-fg", "--logo-filter"]) {
      assert.match(block[2], new RegExp(`${token}:`), `${selector} does not set ${token}`);
    }
  }
  const styles = await text("public/styles.css");
  assert.doesNotMatch(styles, /\.message(?:\.(?:assistant|user|tool-output))?\.pending-review[^}]*--amber/, "pending-review messages use --accent, not yellowish --amber");
  for (const [base, palettes] of [["dark", darkPalettes], ["light", lightPalettes]] as const) {
    for (const id of palettes) {
      assert.ok(assistantSheet.includes(`:root[data-theme=${base}][data-palette=${id}]`), `assistant.css missing ${base}/${id}`);
      assert.ok(assistantTheme.includes(`palette: "${id}"`), `assistant/theme.js missing ${id}`);
    }
  }
});
