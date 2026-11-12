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
