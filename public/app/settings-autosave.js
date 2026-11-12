/**
 * Settings save as they change. Each channel wraps a save Settings already makes (the node's
 * settings, System AI, …). A change marks its channel pending and saves after a pause; a channel
 * runs one save at a time and saves again when something changed meanwhile. One status line, the
 * `status` element, shows what happened: saving, saved, or what failed. A failure is never silent:
 * the line says why, and errors from the node also raise a toast.
 */

/** A problem found before anything is sent: shown on the status line, not raised as a toast. */
export function invalidSetting(message) {
  const error = new Error(message);
  error.invalidSetting = true;
  return error;
}

const TEXT = {
  loading: "Loading settings…",
  unavailable: "Could not load settings. Go back to Joint Bob and open Settings again.",
  idle: "Changes save as you make them",
  pending: "Saving…",
  saving: "Saving…",
  saved: "Saved",
};

export function createAutosave({ status, onError = () => {} }) {
  const channels = new Map();
  const text = status.querySelector(".settings-saved-text") ?? status;
  let base = "loading";
  let showSaved = false;
  let toasted = "";

  function state() {
    const all = [...channels.values()];
    if (all.some((channel) => channel.running)) return "saving";
    if (all.some((channel) => channel.timer || channel.dirty)) return "pending";
    const failed = all.find((channel) => channel.error);
    if (failed) return "failed";
    if (base !== "ready") return base;
    return showSaved ? "saved" : "idle";
  }

  function render() {
    const current = state();
    status.dataset.state = current;
    const failed = [...channels.values()].find((channel) => channel.error);
    status.setAttribute("role", current === "failed" ? "alert" : "status");
    text.textContent = current === "failed" ? `Not saved: ${failed.error}` : TEXT[current];
    status.querySelector(".settings-saved-retry")?.remove();
    if (current === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ghost compact settings-saved-retry";
      retry.dataset.testid = "settings-save-retry";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => { for (const channel of channels.values()) if (channel.error) schedule(channel.name, 0); });
      status.append(retry);
    }
  }

  async function run(channel) {
    clearTimeout(channel.timer);
    channel.timer = null;
    if (channel.running) { channel.dirty = true; return channel.running; }
    // A number or path still being typed would be sent half done: the save waits until it is left.
    if (typingIn(channel.name)) { channel.dirty = true; render(); return undefined; }
    channel.dirty = false;
    channel.running = (async () => {
      try {
        await channel.save();
        channel.error = null;
        showSaved = true;
        toasted = "";
      } catch (error) {
        if (error?.deferred) { channel.dirty = true; return; }
        channel.error = error?.message || String(error);
        if (!error?.invalidSetting && channel.error !== toasted) { toasted = channel.error; onError(error); }
      }
    })();
    render();
    await channel.running;
    channel.running = null;
    // Something changed while the request ran: that change is saved too (unless it is still being typed).
    if (channel.dirty && !typingIn(channel.name)) return run(channel);
    render();
    return undefined;
  }

  function schedule(name, delay = 0) {
    const channel = channels.get(name);
    if (!channel) return;
    channel.dirty = true;
    showSaved = false;
    clearTimeout(channel.timer);
    channel.timer = setTimeout(() => { void run(channel); }, delay);
    render();
  }

  return {
    channel(name, save) { channels.set(name, { name, save, timer: null, running: null, dirty: false, error: null }); },
    schedule,
    /** A change that saves later, when its field is left (or Settings is): shown as waiting now. */
    mark(name) {
      const channel = channels.get(name);
      if (!channel) return;
      channel.dirty = true;
      showSaved = false;
      render();
    },
    /** A section saved by its own button (a routing configuration): nothing of it waits any more. */
    settle(name) {
      const channel = channels.get(name);
      if (!channel || channel.running) return;
      clearTimeout(channel.timer);
      channel.timer = null;
      channel.dirty = false;
      channel.error = null;
      showSaved = true;
      render();
    },
    /** Whether `name` has a change waiting. */
    waiting(name) { const channel = channels.get(name); return Boolean(channel && (channel.timer || channel.dirty || channel.running)); },
    /** Saves what is waiting now, for leaving Settings. Resolves to the errors that remain. */
    async flush() {
      // A save that ends with a newer change waiting runs again, so this waits until all are settled.
      for (let round = 0; round < 10; round += 1) {
        const busy = [...channels.values()].filter((channel) => (channel.timer || channel.dirty || channel.running) && !(channel.dirty && !channel.running && typingIn(channel.name)));
        if (!busy.length) break;
        await Promise.all(busy.map((channel) => channel.running ?? run(channel)));
      }
      return [...channels.values()].map((channel) => channel.error).filter(Boolean);
    },
    /** Waiting changes, for a caller that must not lose them. */
    get pending() { return [...channels.values()].some((channel) => channel.timer || channel.dirty || channel.running); },
    /** "loading", "unavailable" or "ready"; a fresh load also forgets earlier results. */
    setBase(next) {
      base = next;
      showSaved = false;
      if (next === "loading") for (const channel of channels.values()) { clearTimeout(channel.timer); channel.timer = null; channel.dirty = false; channel.error = null; }
      render();
    },
    /** A new section starts from "Changes save as you make them"; a failure stays until it is fixed. */
    quiet() { showSaved = false; render(); },
    render,
  };
}

let shared = null;
/**
 * The one save line of the Settings page, shared by every section that saves as it changes.
 * `settings.js` sets `onError` to raise a toast; until then errors only show on the line.
 */
export function settingsAutosave() {
  if (!shared) {
    const status = document.querySelector("#settingsSaveState");
    shared = createAutosave({ status, onError: (error) => shared.onError?.(error) });
  }
  return shared;
}

const typedField = (target) => target.matches("textarea, input:not([type]), input[type='text'], input[type='url'], input[type='email'], input[type='search']");
/** Numbers and paths save when the field is left: a half-typed value must never apply. */
const SAVE_WHEN_LEFT = "input[type='number'], [data-save-when-left]";

/** Fields typed in but not yet left, with their channel: a save of that channel waits for them. */
const unfinished = new Map();
function typingIn(name) {
  for (const [field, channel] of unfinished) {
    if (!field.isConnected) { unfinished.delete(field); continue; }
    if (channel === name) return true;
  }
  return false;
}

/** Thrown by a save that read the page while a field was still being typed: it runs again once the field is left. */
export function deferSave() {
  return Object.assign(new Error("A field is still being typed"), { deferred: true });
}
/** For a save that awaited something: whether `name` now has a field still being typed. */
export { typingIn as stillTyping };

/**
 * Saves `name`'s channel when a field under `root` changes: typed text after a pause, numbers
 * and fields marked `data-save-when-left` when left, switches and dropdowns at once (searchable
 * dropdowns announce "choice-change"). `accept(target)` picks the fields that belong to it;
 * `askFirst(target)` may ask first and resolve false when the change was put back.
 */
export function autosaveFields(root, name, { accept = (target) => target.matches("input, select, textarea, .searchable-select-trigger"), askFirst = async () => true } = {}) {
  const autosave = settingsAutosave();
  // A dropdown's own search box is not a setting.
  const belongs = (target) => target instanceof Element && !target.closest(".searchable-select-popover") && accept(target);
  root.addEventListener("input", (event) => {
    if (!belongs(event.target)) return;
    // Shown as waiting at once, so nobody leaves thinking it saved.
    if (event.target.matches(SAVE_WHEN_LEFT)) { unfinished.set(event.target, name); autosave.mark(name); }
    else if (typedField(event.target)) autosave.schedule(name, 800);
  });
  root.addEventListener("change", async (event) => {
    if (!belongs(event.target)) return;
    unfinished.delete(event.target);
    // Waiting from this moment, also while a question is open; a No saves the choice it put back.
    autosave.mark(name);
    const allowed = await askFirst(event.target);
    autosave.schedule(name, !allowed || typedField(event.target) || event.target.matches(SAVE_WHEN_LEFT) ? 0 : 120);
  });
  // Left without a change event (typed, then put back as it was): what waited is saved now.
  root.addEventListener("focusout", (event) => {
    if (!unfinished.has(event.target) || unfinished.get(event.target) !== name) return;
    unfinished.delete(event.target);
    autosave.schedule(name, 0);
  });
  root.addEventListener("choice-change", (event) => { if (belongs(event.target)) autosave.schedule(name, 120); });
}
