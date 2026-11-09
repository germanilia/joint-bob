// This card is UI only: never serialize it into transcript messages or save its inputs.
export function createBrowserLoginCard(host, { api, session: initial, isCurrent, onSession, onTakeover, onDismiss }) {
  let session = initial, step = null, disposed = false, busy = false, completed = false, completionTimer;
  host.classList.add("browser-login-card");
  // Built as nodes, as everywhere in the app: no markup is ever parsed from a string.
  const node = (tag, attributes = {}, text) => {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const header = node("header");
  header.append(node("strong", {}, "Secure sign-in"), node("button", { type: "button", "data-testid": "browser-login-dismiss", "aria-label": "Dismiss sign-in" }, "Dismiss"));
  const footer = node("footer");
  footer.append(
    node("button", { type: "button", "data-testid": "browser-login-refresh" }, "Refresh step"),
    node("button", { type: "button", "data-testid": "browser-login-takeover" }, "Open browser"),
    node("button", { type: "button", "data-testid": "browser-login-done", hidden: "" }, "I'm signed in"),
  );
  const content = node("div", { class: "browser-login-card-content" });
  content.append(
    header,
    node("p", { "data-testid": "browser-login-origin", class: "browser-login-card-origin" }),
    node("p", { class: "browser-login-card-privacy" }, "Credentials go directly to your browser—not into this conversation."),
    node("p", { "data-testid": "browser-login-status", role: "status", "aria-live": "polite" }, "Connecting to sign-in…"),
    node("form", { "data-testid": "browser-login-form" }),
    footer,
  );
  host.replaceChildren(content);
  const get = id => host.querySelector(`[data-testid="browser-login-${id}"]`);
  const form = get("form"), status = get("status"), done = get("done");
  const current = () => !disposed && isCurrent();
  const clear = () => { for (const input of form.querySelectorAll("input")) input.value = ""; form.replaceChildren(); step = null; };
  function lock(value) {
    busy = value;
    for (const control of host.querySelectorAll("input,button")) control.disabled = value;
    get("dismiss").disabled = false;
  }
  async function command(value) {
    if (!current()) throw new Error("Sign-in card closed");
    const url = `/api/browser/sessions/${encodeURIComponent(session.id)}/command?${new URLSearchParams({ nodeId: session.nodeId })}`;
    const response = await api(url, { method: "POST", body: JSON.stringify(value) });
    if (!current()) return null;
    const previousRequestId = session.loginRequest?.id;
    session = response.session;
    if (value.action !== "completeLogin" && (session.state !== "running" || session.loginRequest?.id !== previousRequestId)) {
      clear(); onSession?.(session); return null;
    }
    return response;
  }
  function target() {
    return { requestId: session.loginRequest.id, expectedPageId: session.activePageId };
  }
  function renderStep(next) {
    clear(); step = next;
    get("origin").textContent = next.origin;
    status.textContent = next.challenge ? "This step needs the browser: complete the challenge or review the sign-in error there."
      : next.stepId ? "Sign in to continue. The agent stays paused."
      : "No supported credential form is visible. Open the browser to continue, or confirm if you're signed in.";
    done.hidden = Boolean(next.stepId || next.challenge);
    if (!next.stepId) return;
    next.fields.forEach((field, index) => {
      const label = document.createElement("label"); label.textContent = field.label;
      const input = document.createElement("input"); input.type = field.type;
      input.name = `login-field-${index}`; input.autocomplete = field.autocomplete; input.required = true;
      input.dataset.testid = `browser-login-field-${index}`;
      label.append(input); form.append(label);
    });
    const submit = document.createElement("button"); submit.type = "submit";
    submit.dataset.testid = "browser-login-submit"; submit.textContent = next.submitLabel;
    form.append(submit);
  }
  async function read() {
    if (!current() || busy || completed) return;
    clear(); done.hidden = true; lock(true);
    try {
      const response = await api(`/api/browser/sessions/${encodeURIComponent(session.id)}?${new URLSearchParams({ nodeId: session.nodeId })}`);
      if (disposed) return;
      onSession?.(response.session);
      if (!current()) return;
      session = response.session;
      if (!session.loginRequest || session.state !== "running") return;
      if (session.owner !== "human" || session.canControl === false) {
        await command({ action: "takeControl", loginRequestId: session.loginRequest.id, ...(session.owner === "human" ? { force: true } : {}) });
      }
      if (!current()) return;
      const observation = await command({ action: "readLoginStep", ...target() });
      if (current() && observation) renderStep(observation.result);
    } catch {
      if (current()) status.textContent = "Could not read sign-in. Refresh the step or open the browser; the agent remains paused.";
    } finally { if (current()) lock(false); }
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!current() || busy || !step?.stepId) return;
    const submission = { action: "submitLoginStep", ...target(), expectedOrigin: step.origin, stepId: step.stepId, values: [...form.querySelectorAll("input")].map(input => input.value) };
    clear(); done.hidden = true; lock(true); status.textContent = "Submitting sign-in…";
    let confirmed = false;
    try { await command(submission); confirmed = true; }
    catch { if (current()) status.textContent = "Submission not confirmed. Check the current step before trying again; nothing was retried."; }
    finally { submission.values.fill(""); submission.values.length = 0; if (current()) lock(false); }
    if (confirmed && current()) await read();
  });
  done.addEventListener("click", async () => {
    if (!current() || busy || completed) return;
    clear(); lock(true);
    try {
      const response = await command({ action: "completeLogin", ...target() });
      if (!current() || !response) return;
      completed = true; status.textContent = "Signed in. The agent can continue.";
      get("refresh").hidden = true; get("takeover").hidden = true; done.hidden = true;
      completionTimer = setTimeout(() => { if (current()) onSession?.(response.session); }, 2000);
    } catch {
      if (current()) { status.textContent = "Sign-in could not be verified. Open the browser to finish; the agent remains paused."; lock(false); }
    }
  });
  get("refresh").addEventListener("click", () => void read());
  get("takeover").addEventListener("click", () => { if (current() && !busy) { clear(); onTakeover(); } });
  get("dismiss").addEventListener("click", () => onDismiss());
  void read();
  return { dispose() { disposed = true; clearTimeout(completionTimer); clear(); } };
}
