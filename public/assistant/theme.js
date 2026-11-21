// Runs synchronously before first paint (a classic script in <head>), so the assistant is never painted in the wrong theme.
// It applies the theme this device chose in the main app (Settings › Account › Appearance, public/app/appearance.js):
// the same localStorage entry, the same data-theme / data-palette on <html>. No stored theme follows the device.
(() => {
  const STORAGE_KEY = "jointBobAppearance";
  const THEMES = {
    light: { theme: "light", color: "#f2ebdf" },
    sepia: { theme: "light", palette: "sepia", color: "#efe6d4" },
    dark: { theme: "dark", color: "#171412" },
    midnight: { theme: "dark", palette: "midnight", color: "#0e1320" },
    graphite: { theme: "dark", palette: "graphite", color: "#1a1a1b" },
    dracula: { theme: "dark", palette: "dracula", color: "#1e1f29" },
    "tokyo-night": { theme: "dark", palette: "tokyo-night", color: "#16161e" },
    "catppuccin-mocha": { theme: "dark", palette: "catppuccin-mocha", color: "#181825" },
    nord: { theme: "dark", palette: "nord", color: "#242933" },
    "one-dark-pro": { theme: "dark", palette: "one-dark-pro", color: "#21252b" },
    "vscode-dark": { theme: "dark", palette: "vscode-dark", color: "#181818" },
    "github-dark": { theme: "dark", palette: "github-dark", color: "#010409" },
    "night-owl": { theme: "dark", palette: "night-owl", color: "#01111d" },
    palenight: { theme: "dark", palette: "palenight", color: "#212432" },
    synthwave: { theme: "dark", palette: "synthwave", color: "#1c1629" },
    "gruvbox-dark": { theme: "dark", palette: "gruvbox-dark", color: "#1d2021" },
    "monokai-pro": { theme: "dark", palette: "monokai-pro", color: "#221f22" },
    "solarized-dark": { theme: "dark", palette: "solarized-dark", color: "#00212b" },
    "rose-pine": { theme: "dark", palette: "rose-pine", color: "#191724" },
    kanagawa: { theme: "dark", palette: "kanagawa", color: "#16161d" },
    "vscode-light": { theme: "light", palette: "vscode-light", color: "#f3f3f3" },
    "catppuccin-latte": { theme: "light", palette: "catppuccin-latte", color: "#e6e9ef" },
    "solarized-light": { theme: "light", palette: "solarized-light", color: "#eee8d5" },
    "github-light": { theme: "light", palette: "github-light", color: "#f6f8fa" },
    "gruvbox-light": { theme: "light", palette: "gruvbox-light", color: "#ebdbb2" },
  };
  const systemDark = matchMedia("(prefers-color-scheme: dark)");

  function storedTheme() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")?.theme || ""; } catch { return ""; }
  }

  function apply() {
    const chosen = THEMES[storedTheme()] ?? THEMES[systemDark.matches ? "dark" : "light"];
    const root = document.documentElement;
    root.dataset.theme = chosen.theme;
    if (chosen.palette) root.dataset.palette = chosen.palette;
    else delete root.dataset.palette;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = chosen.color;
  }

  apply();
  systemDark.addEventListener("change", apply);
  // A theme picked in the main app in another tab applies here too.
  addEventListener("storage", (event) => { if (event.key === STORAGE_KEY || event.key === null) apply(); });
})();
