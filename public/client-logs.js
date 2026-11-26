// Capture diagnostics before application modules load. Session storage survives a
// reload but remains local to this browser tab; bounded entries avoid causing the
// memory pressure this log exists to diagnose.
(() => {
  const key = "joint-bob-client-logs-v1";
  const limit = 250;
  const argumentLimit = 4000;
  let entries = [];
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) || "[]");
    if (Array.isArray(stored)) entries = stored.filter((entry) => typeof entry === "string").slice(-limit);
  } catch {
    entries = [];
  }
  const errorText = (error) => {
    const head = `${error.name}: ${error.message}`;
    return error.stack && !error.stack.includes(error.message) ? `${head}\n${error.stack}` : error.stack || head;
  };
  const format = (value) => {
    if (value instanceof Error) {
      // Safari's stack omits the message, so it alone said only "api@…/api.js:17:20".
      const stack = errorText(value);
      let fields = "";
      try { if (Object.keys(value).length) fields = ` ${JSON.stringify({ ...value })}`; } catch { /* circular fields */ }
      return `${stack}${fields}${value.cause === undefined ? "" : `\nCaused by: ${format(value.cause)}`}`;
    }
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const record = (level, values) => {
    const message = values.map(format).join(" ").slice(0, argumentLimit);
    entries.push(`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`);
    entries = entries.slice(-limit);
    try { sessionStorage.setItem(key, JSON.stringify(entries)); } catch { /* storage unavailable */ }
    window.dispatchEvent(new Event("joint-bob-client-logs-changed"));
    if (level === "error" || level === "uncaught" || level === "unhandled") {
      // Console objects can contain transcripts or bodies. Keep their fields in this tab's logs only.
      const diagnostic = values.map(value => value instanceof Error ? errorText(value) : typeof value === "string" ? value : "").filter(Boolean).join(" ");
      window.dispatchEvent(new CustomEvent("joint-bob-client-error", { detail: { kind: level, message: diagnostic || "Browser error (see local logs)" } }));
    }
  };
  for (const level of ["debug", "info", "log", "warn", "error"]) {
    const native = console[level].bind(console);
    console[level] = (...values) => { record(level, values); native(...values); };
  }
  window.addEventListener("error", (event) => record("uncaught", [event.error || `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`]));
  window.addEventListener("unhandledrejection", (event) => record("unhandled", [event.reason]));
  window.jointBobClientLogs = {
    entries: () => [...entries],
    clear: () => { entries = []; try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ } window.dispatchEvent(new Event("joint-bob-client-logs-changed")); },
  };
  const navigation = performance.getEntriesByType("navigation")[0]?.type || "navigate";
  record("page", [`loaded navigation=${navigation} visibility=${document.visibilityState}`]);
})();
