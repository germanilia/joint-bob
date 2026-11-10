import { api } from "./api.js";

const endpoint = "/api/harnesses/antigravity/login";

export function antigravityLoginControls(ready, onComplete) {
  const root = document.createElement("fieldset"); root.className = "phase-settings";
  const legend = document.createElement("legend"); legend.textContent = "Google sign-in on this execution node";
  const hint = document.createElement("p"); hint.className = "hint";
  hint.textContent = "Uses the official Antigravity CLI, not Pi OAuth or a Google API key. Save path changes before signing in. Your Google login stays on this node.";
  const status = document.createElement("output"); status.setAttribute("aria-live", "polite"); status.dataset.testid = "antigravity-login-status";
  const start = button("Sign in with Google", "antigravity-login-start");
  const cancel = button("Cancel sign-in", "antigravity-login-cancel");
  const link = document.createElement("a"); link.textContent = "Open Google sign-in"; link.target = "_blank"; link.rel = "noopener noreferrer"; link.dataset.testid = "antigravity-login-url";
  const prompt = document.createElement("div");
  const label = document.createElement("label"); label.textContent = "Authorization code or final redirect URL";
  const input = document.createElement("input"); input.type = "password"; input.autocomplete = "off"; input.dataset.testid = "antigravity-login-answer";
  const submit = button("Complete sign-in", "antigravity-login-submit");
  label.append(input); prompt.append(label, submit);
  root.append(legend, hint, status, start, link, prompt, cancel);
  let current = null, busy = false, notified = false, timer;

  function render(login) {
    current = login;
    const waiting = login?.state === "waiting";
    status.textContent = login?.message || (ready ? "Google Antigravity is signed in on this node" : "Sign in with Google to use Antigravity on this node");
    start.disabled = busy || waiting; cancel.hidden = !waiting; cancel.disabled = busy;
    link.hidden = !login?.url;
    if (login?.url) link.href = login.url; else link.removeAttribute("href");
    prompt.hidden = !login?.prompt; input.disabled = busy; submit.disabled = busy;
  }

  async function refresh() {
    try {
      const { login } = await api(endpoint);
      render(login);
      if (login?.state === "complete" && !notified) { notified = true; await onComplete(); }
      if (login?.state === "waiting") schedule();
    } catch (error) { status.textContent = `Could not read sign-in status: ${error.message}`; }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (root.isConnected && root.closest("dialog")?.open) void refresh(); }, 1_000);
  }

  async function action(method, body) {
    clearTimeout(timer); busy = true; render(current);
    try {
      const { login } = await api(endpoint, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (method === "POST") notified = false;
      busy = false; render(login);
      if (login?.state === "waiting") schedule();
    } catch (error) { busy = false; render(current); status.textContent = error.message; if (current?.state === "waiting") schedule(); }
  }

  start.addEventListener("click", () => void action("POST", {}));
  cancel.addEventListener("click", () => { input.value = ""; void action("DELETE"); });
  const answer = () => { const value = input.value; input.value = ""; if (value.trim()) void action("PUT", { answer: value }); };
  submit.addEventListener("click", answer);
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); answer(); } });
  render(null); void refresh();
  return root;
}

function button(text, testid) {
  const element = document.createElement("button"); element.type = "button"; element.className = "ghost"; element.textContent = text; element.dataset.testid = testid;
  return element;
}
