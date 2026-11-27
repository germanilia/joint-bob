import { api } from "./api.js";
import { confirmAction, toast } from "./shell.js";

let expanded = false, advanced = false, busy = false, flow = null, connectError = "";
let statuses = new Map();
const draft = { quickUrl: "", name: "", url: "", json: "", callback: "", authMode: "shared" };
let scopeKey = "", nativeError = "";
function selectScope(scope) {
  const key = scope.projectId || "";
  if (key !== scopeKey) { scopeKey = key; statuses = new Map(); nativeError = ""; }
}
function authBase(server) { return server.authMode === "native" ? "/api/resources/mcp/native" : base; }
const base = "/api/resources/mcp/managed";
function button(text, id, action) {
  const control = document.createElement("button"); control.type = "button"; control.className = "ghost compact";
  control.textContent = text; control.dataset.testid = id; control.disabled = busy;
  control.addEventListener("click", action); return control;
}
async function perform(action, changed) {
  busy = true;
  try { await action(); }
  catch (error) {
    if (flow && flow.scopeKey === scopeKey) statuses.set(flow.serverName, { status: "failed", error: error.message });
    toast.error(error.message);
  }
  finally { busy = false; await changed(); }
}
function input(label, key, placeholder, multiline = false) {
  const field = document.createElement("label"); field.textContent = label;
  const control = document.createElement(multiline ? "textarea" : "input");
  control.dataset.testid = `managed-mcp-${key}`; control.value = draft[key]; control.placeholder = placeholder;
  control.autocomplete = "off"; control.spellcheck = false;
  if (multiline) control.rows = 3;
  control.addEventListener("input", () => { draft[key] = control.value; }); field.append(control); return field;
}
async function openSignIn(endpoint, route, payload, tab, key) {
  try {
    const result = await api(`${endpoint}/${route}`, { method: "POST", body: JSON.stringify(payload) });
    if (!result.authUrl) {
      tab?.close();
      if (key === scopeKey) statuses.set(result.serverName, { status: "connected" });
      return;
    }
    flow = { ...result, base: endpoint, scopeKey: key };
    if (tab) { tab.opener = null; tab.location.href = result.authUrl; }
  } catch (error) { tab?.close(); throw error; }
}

function quickSetup(supported, changed) {
  const form = document.createElement("form");
  const hint = document.createElement("p");
  hint.textContent = `Sign in once for ${supported}. The connection stays with your account on this machine.`;
  const url = input("Server URL", "quickUrl", "https://mcp.figma.com/mcp");
  const field = url.querySelector("input"); field.type = "url"; field.required = true;
  const connect = button("Connect", "managed-mcp-connect", () => {}); connect.type = "submit";
  form.append(hint, url, connect);
  if (connectError) {
    const error = document.createElement("p"); error.setAttribute("role", "alert"); error.textContent = connectError; form.append(error);
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (busy || flow) { toast("Finish or cancel the open MCP sign-in first"); return; }
    const tab = window.open("about:blank", "_blank"), key = scopeKey;
    connect.disabled = true;
    void perform(async () => {
      try {
        await openSignIn(base, "connect", { url: draft.quickUrl.trim() }, tab, key);
        draft.quickUrl = ""; connectError = ""; expanded = false;
      } catch (error) { connectError = error.message; throw error; }
    }, changed);
  });
  return form;
}

export function managedMcpSetup(harnesses, changed, scope = {}) {
  selectScope(scope);
  const section = document.createElement("section"); section.className = "resources-add"; section.dataset.testid = "managed-mcp-setup";
  const actions = document.createElement("div"); actions.className = "resources-share-line";
  actions.append(button(expanded ? "Hide MCP setup" : "Add MCP servers", "managed-mcp-add", () => { expanded = !expanded; void changed(); }),
    button("Check connections", "managed-mcp-check", () => void perform(async () => {
      const key = scopeKey;
      const result = await api(`${base}/auth`);
      if (key !== scopeKey) return;
      statuses = new Map(result.servers.map(server => [server.name, server]));
      try {
        const query = new URLSearchParams(scope);
        const native = await api(`/api/resources/mcp/native/auth?${query}`);
        if (key === scopeKey) { nativeError = ""; for (const server of native.servers) statuses.set(server.name, server); }
      } catch (error) { if (key === scopeKey) nativeError = error.message; }
    }, changed)));
  section.append(actions);
  if (expanded) {
    const supported = new Intl.ListFormat("en").format(harnesses.map(({ label }) => label));
    section.append(quickSetup(supported, changed));
    const details = document.createElement("details"); details.open = advanced;
    details.addEventListener("toggle", () => { advanced = details.open; });
    const summary = document.createElement("summary"); summary.textContent = "Advanced setup"; summary.dataset.testid = "managed-mcp-advanced";
    const form = document.createElement("form"); form.dataset.testid = "managed-mcp-form";
    form.append(input("Server name", "name", "figma"), input("Remote MCP URL", "url", "https://mcp.figma.com/mcp"),
      input("Or import multiple servers as MCP JSON. Stdio commands run as your account.", "json", '{"mcpServers":{"figma":{"url":"https://mcp.figma.com/mcp"},"local":{"command":"node","args":["/path/server.mjs"]}}}', true));
    const installLabel = () => draft.authMode === "native" ? "Install for Pi" : "Install shared connection";
    const install = button(installLabel(), "managed-mcp-install", () => {}); install.type = "submit";
    const mode = document.createElement("select"); mode.dataset.testid = "managed-mcp-auth-mode"; mode.setAttribute("aria-label", "MCP sign-in mode");
    mode.replaceChildren(new Option(`Shared connection · ${supported}`, "shared"), new Option("Native Pi OAuth · Pi only", "native"));
    mode.value = draft.authMode; mode.addEventListener("change", () => { draft.authMode = mode.value; install.textContent = installLabel(); });
    form.append(mode, install); form.addEventListener("submit", event => {
      event.preventDefault();
      void perform(async () => {
        const config = draft.json.trim() ? JSON.parse(draft.json) : { mcpServers: { [draft.name.trim()]: { url: draft.url.trim() } } };
        for (const server of Object.values(config.mcpServers)) server.authMode = draft.authMode;
        if (!await confirmAction({ title: "Install MCP servers?", message: "MCP tools can access external services. Local commands run with your account's permissions. Install only servers you trust.", confirmLabel: "Install servers" })) return;
        const result = await api(base, { method: "POST", body: JSON.stringify(config) });
        draft.name = ""; draft.url = ""; draft.json = ""; expanded = false; toast(`Installed ${result.installed.join(", ")}`);
      }, changed);
    }); details.append(summary, form); section.append(details);
  }
  if (flow) {
    const note = document.createElement("p"); note.textContent = `Signing in to ${flow.serverName}. Finish in the new tab, then choose Done. If the localhost page cannot load, paste its full address below.`;
    section.append(note, input("Redirect address, if needed", "callback", "http://127.0.0.1:…/callback?code=…"),
      button("Done", "managed-mcp-done", () => void perform(async () => {
        const result = await api(`${flow.base}/auth/finish`, { method: "POST", body: JSON.stringify({ flowId: flow.flowId, ...(draft.callback.trim() ? { callbackUrl: draft.callback.trim() } : {}) }) });
        if (flow.scopeKey === scopeKey) statuses.set(result.server.name, result.server);
        if (result.server.status === "connected") { flow = null; draft.callback = ""; toast("MCP sign-in verified on this machine"); }
        else toast("Sign-in is not finished yet");
      }, changed)),
      button("Open sign-in page", "managed-mcp-reopen", () => { const tab = window.open(flow.authUrl, "_blank"); if (tab) tab.opener = null; }),
      button("Cancel", "managed-mcp-cancel", () => void perform(async () => { await api(`${flow.base}/auth/cancel`, { method: "POST", body: JSON.stringify({ flowId: flow.flowId }) }); flow = null; draft.callback = ""; }, changed)));
  }
  return section;
}
export function managedMcpControls(server, changed, scope = {}) {
  selectScope(scope);
  const controls = [];
  const endpoint = authBase(server);
  const initiatingKey = scopeKey;
  const report = (message) => { if (initiatingKey === scopeKey) statuses.set(server.name, { status: "failed", error: message }); };
  const state = statuses.get(server.name);
  if (state) { const text = document.createElement("span"); text.textContent = state.status === "needs-auth" ? "Sign in required" : state.status; text.title = state.error ?? ""; text.dataset.testid = "managed-mcp-status"; controls.push(text); }
  const failure = state?.error || (server.authMode === "native" ? nativeError : "");
  if (failure) { const error = document.createElement("span"); error.textContent = failure; error.dataset.testid = "managed-mcp-error"; controls.push(error); }
  if (server.authMode === "native") { const label = document.createElement("span"); label.textContent = "Native Pi"; controls.push(label); }
  if (server.transport !== "stdio") controls.push(button("Sign in", "managed-mcp-sign-in", () => {
    if (flow) { toast("Finish or cancel the open MCP sign-in first"); return; }
    const tab = window.open("about:blank", "_blank");
    void perform(async () => {
      try {
        await openSignIn(endpoint, "auth/start", { serverName: server.name, ...(server.authMode === "native" ? scope : {}) }, tab, initiatingKey);
      } catch (error) { report(error.message); throw error; }
    }, changed);
  }), button("Sign out", "managed-mcp-sign-out", () => void perform(async () => {
    try {
      await api(`${endpoint}/auth/sign-out`, { method: "POST", body: JSON.stringify({ serverName: server.name, ...(server.authMode === "native" ? scope : {}) }) });
      if (initiatingKey === scopeKey) statuses.delete(server.name);
    } catch (error) { report(error.message); throw error; }
  }, changed)));
  controls.push(button("Remove", "managed-mcp-remove", () => void perform(async () => {
    if (!await confirmAction({ title: `Remove ${server.name}?`, message: "Remove this MCP server from your account on this machine. For native Pi, sign out in each runtime scope first to clear its saved grant.", confirmLabel: "Remove", destructive: true })) return;
    await api(`${base}/${encodeURIComponent(server.name)}`, { method: "DELETE" }); statuses.delete(server.name);
    if (flow?.serverName === server.name) flow = null;
  }, changed)));
  return controls;
}
