// The automation editor: one full page inside the control-center Automations tab for every automation, whatever starts it.
// This file is the shell: it owns the page, the Setup and History tabs, the save bar and every call that saves. The
// Trigger, Run and Context tabs are their own modules and answer the interface in
// docs/superpowers/plans/2026-11-17-automations-ui-contract.md.
import { api } from "./api.js";
import { createAutomationTagPicker } from "./automation-tag-picker.js";
import { createContextTab } from "./automation-context.js";
import { createRunTab } from "./automation-run.js";
import { createTriggerTab } from "./automation-trigger.js";
import { selectProject } from "./project-selection.js";
import { copyText, createFittedList, formatWhen, makeBadge, makeButton, makeNode, makeTwoStepButton, showStatus } from "./relay-ui.js";
import { toast } from "./shell.js";
import { openSession } from "./socket.js";

const TRIGGERS = {
  schedule: {
    badge: "⏱ schedule", title: "⏱ On a schedule", hint: "Runs at set times: once, every few minutes or hours, daily, weekly or monthly.",
    label: "What should the agent do each time?", help: "This is the whole message each run starts with.", summary: "⏱ On a schedule",
    warning: "Switching to a schedule removes this automation's webhook address when you save. Calls to it will be refused.",
  },
  webhook: {
    badge: "⚡ webhook", title: "⚡ When a webhook is called", hint: "Another service calls a secret address. The call's content goes to the agent.",
    label: "What should the agent do with each call?", help: "Goes ahead of the call's content in every message.", summary: "⚡ On each webhook call",
    warning: "Switching to a webhook stops the schedule and makes a secret address when you save. It is shown once, right after saving.",
  },
};
const TABS = [["setup", "Setup"], ["trigger", "Trigger"], ["run", "Run"], ["context", "Context"], ["history", "History"]];
const INPUT_KEYS = ["trigger", "name", "target", "context", "enabled", "tags", "model", "reasoning", "titleTemplate", "secretAccountIds", "providerProfileId", "providerPoolId",
  "bypassGuardian", "markForReview", "hideFromHistory", "preserveFiles", "runInWorktree", "autoRespond", "pauseOnFailure", "schedule", "attachments", "senders"];
const NO_TAGS = { managedTagIds: [], manualTags: [] };
const BADGE_TONES = { ok: "ok", succeeded: "ok", delivered: "ok", failed: "bad", refused: "bad" };

let host = null;
let afterClose = () => undefined;
let active = null;

const errorText = (error) => error?.message || "Something went wrong";
const nodeQuery = (nodeId) => (nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : "");
/** "" is this machine, whatever its real id. */
const ownerKey = (owner) => (owner.local ? "" : owner.id);
const pickInput = (item) => Object.fromEntries(INPUT_KEYS.map((key) => [key, item[key]]));

/** Called once by the Automations tab: `host` holds the page while it is open and `onClose` runs when it goes away. */
export function mountAutomationEditor({ host: element, onClose }) {
  host = element;
  afterClose = onClose;
}

export function closeAutomationEditor() {
  if (!active) return;
  active.remove();
  active = null;
  host.classList.remove("editing");
  afterClose();
}

function labeled(label, control, hint = "") {
  const wrapper = makeNode("label", "automation-field");
  wrapper.append(makeNode("span", "automation-field-label", label), control, makeNode("small", "automation-field-hint", hint));
  return wrapper;
}

function card(title, hint) {
  const node = makeNode("section", "automation-card");
  const heading = makeNode("header", "automation-card-head");
  heading.append(makeNode("h4", "automation-card-title", title));
  if (hint) heading.append(makeNode("p", "automation-hint", hint));
  node.append(heading);
  return node;
}

// ── Setup ─────────────────────────────────────────────────────────────────────────────────────────────

function createSetupTab(ctx, { onPick, onProject }) {
  const { state } = ctx;
  const element = makeNode("div", "automation-panel");
  let originalTrigger = null;

  const choice = card("What starts it", "Pick one. You can change it later; the Trigger tab holds its settings.");
  const picker = makeNode("div", "automation-trigger-cards");
  picker.setAttribute("role", "radiogroup");
  picker.setAttribute("aria-label", "What starts it");
  const cards = Object.entries(TRIGGERS).map(([kind, copy]) => {
    const button = makeNode("button", "automation-trigger-card");
    button.type = "button";
    button.setAttribute("role", "radio");
    button.dataset.testid = `automation-trigger-${kind}`;
    const text = makeNode("span", "automation-trigger-text");
    text.append(makeNode("b", "", copy.title), makeNode("small", "", copy.hint));
    button.append(makeNode("span", "automation-radio"), text);
    button.addEventListener("click", () => onPick(kind));
    picker.append(button);
    return [kind, button];
  });
  const warning = makeNode("p", "automation-callout");
  warning.dataset.testid = "automation-trigger-warning";
  warning.hidden = true;
  choice.append(picker, warning);

  const name = makeNode("input");
  name.type = "text";
  name.maxLength = 120;
  name.placeholder = "e.g. Weekly dependency check – [week]";
  name.dataset.testid = "automation-setup-name";
  const project = makeNode("select");
  project.dataset.testid = "automation-setup-project";
  const instructions = makeNode("textarea");
  instructions.rows = 6;
  instructions.dataset.testid = "automation-setup-instructions";
  const instructionsField = labeled("", instructions);
  const titleTemplate = makeNode("input");
  titleTemplate.type = "text";
  titleTemplate.maxLength = 120;
  titleTemplate.dataset.testid = "automation-setup-title";
  const tags = makeNode("div");
  const tagPicker = createAutomationTagPicker(tags, "automation-tags");
  const pair = makeNode("div", "automation-grid");
  pair.append(
    labeled("Name", name, "For new conversations the agent fills [placeholders] in the name. Text outside brackets stays fixed."),
    labeled("Project", project, "Each run starts a conversation here, with the project's settings and inherited credentials."),
  );
  const tagField = makeNode("div", "automation-field");
  tagField.append(makeNode("span", "automation-field-label", "Tags"), tags);
  element.append(choice, pair, instructionsField, labeled("Conversation title", titleTemplate, "Optional. Blank uses the name."), tagField);

  const fillProjects = () => {
    project.replaceChildren(...state.options.projects.map((option) => new Option(option.name, option.id)));
    project.value = state.projectId;
  };
  const syncWorkspace = async () => {
    const { project: chosen } = await api(`/api/projects/${encodeURIComponent(project.value)}`);
    await tagPicker.setWorkspace(chosen.type ?? "personal");
  };

  element.addEventListener("input", ctx.markDirty);
  element.addEventListener("change", ctx.markDirty);
  tags.addEventListener("click", ctx.markDirty);
  project.addEventListener("change", () => ctx.run(async () => {
    await syncWorkspace();
    tagPicker.setValue(NO_TAGS);
    await onProject(project.value);
  }));

  return {
    element,
    async fill(item, defaults) {
      originalTrigger = item?.trigger ?? null;
      name.value = item?.name ?? "";
      instructions.value = item?.context ?? "";
      titleTemplate.value = item?.titleTemplate ?? "";
      fillProjects();
      project.disabled = (item?.target ?? defaults.target)?.kind === "assistant";
      await syncWorkspace();
      tagPicker.setValue(item?.tags ?? NO_TAGS);
      this.onTrigger(state.trigger);
    },
    read() {
      if (!name.value.trim()) throw new Error("Give the automation a name.");
      if (state.trigger === "schedule" && !instructions.value.trim()) throw new Error("Say what the agent should do each time.");
      return { name: name.value, context: instructions.value, tags: tagPicker.getValue(), titleTemplate: titleTemplate.value };
    },
    onTrigger(kind) {
      for (const [candidate, button] of cards) {
        button.classList.toggle("picked", candidate === kind);
        button.setAttribute("aria-checked", String(candidate === kind));
      }
      instructionsField.firstChild.textContent = TRIGGERS[kind].label;
      instructionsField.lastChild.textContent = TRIGGERS[kind].help;
      warning.hidden = !originalTrigger || originalTrigger === kind;
      warning.textContent = TRIGGERS[kind].warning;
    },
    onNode: fillProjects,
  };
}

// ── History ───────────────────────────────────────────────────────────────────────────────────────────

function createHistoryTab(ctx, { onAdopt }) {
  const { state } = ctx;
  const element = makeNode("div", "automation-panel");
  let history = { runs: [], calls: [] };

  const section = (title, testPrefix, emptyText, rows, renderItem) => {
    const box = card(title);
    const list = makeNode("div", "automation-history-list");
    const pager = makeNode("div", "automation-history-pager");
    box.append(list, pager);
    const fitted = createFittedList({
      list, pager, testPrefix, emptyText, initialSize: 6, renderItem,
      fetchPage: async (page, size) => ({ total: rows().length, items: rows().slice((page - 1) * size, page * size) }),
    });
    return { box, fitted };
  };
  const row = (...cells) => {
    const node = makeNode("div", "automation-history-row");
    node.append(...cells);
    return node;
  };
  const badge = (status) => makeBadge(status, BADGE_TONES[status] ?? "");

  async function openConversation(item) {
    const { projectId } = state.item.target;
    await selectProject(projectId);
    const { sessions } = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
    const session = sessions.find((candidate) => candidate.id === item.sessionId);
    if (!session) throw new Error("That conversation is not available on this machine.");
    openSession(session.path, session.title || state.item.name);
  }

  function allowSender(sender) {
    return ctx.run(async () => {
      const body = pickInput(state.item);
      body.senders = { ...body.senders, allowed: [...body.senders.allowed, { value: sender, label: "" }] };
      const { automation } = await api(ctx.url(), { method: "PUT", body: JSON.stringify(body) });
      await onAdopt(automation);
      await refresh();
      ctx.say(`Sender ${sender} is allowed. Add a name for it under Trigger.`, "ok");
    });
  }

  const runs = section("Runs", "automation-runs", "No runs yet.", () => history.runs, (item) => {
    const cells = [makeNode("span", "automation-history-when", formatWhen(item.dueAt)), badge(item.status), makeNode("span", "automation-history-detail", item.error ?? "")];
    if (item.sessionId) cells.push(makeButton("Open conversation", "automation-run-open", () => ctx.run(() => openConversation(item))));
    return row(...cells);
  });
  const calls = section("Calls", "automation-calls", "No calls yet.", () => history.calls, (call) => {
    const cells = [makeNode("span", "automation-history-when", formatWhen(call.at)), badge(call.status), makeNode("span", "automation-history-detail", call.detail)];
    const senders = state.item.senders;
    if (call.status === "refused" && call.sender && senders && !senders.allowed.some(({ value }) => value === call.sender)) {
      cells.push(makeButton("Allow", "automation-call-allow", () => allowSender(call.sender)));
    }
    return row(...cells);
  });
  element.append(runs.box, calls.box);

  async function refresh() {
    history = await api(ctx.url("/history"));
    await Promise.all([runs.fitted.reload(), calls.fitted.reload()]);
  }

  return {
    element,
    fill(item) { calls.box.hidden = item?.trigger !== "webhook"; },
    onShow: refresh,
  };
}

// ── The editor ────────────────────────────────────────────────────────────────────────────────────────

export async function openAutomationEditor({ item = null, projectId = null, nodeId = null, target = null }) {
  active?.remove();
  const element = makeNode("section", "automation-editor");
  element.dataset.testid = "automation-editor";
  element.append(makeNode("p", "automation-hint", "Loading…"));
  active = element;
  host.classList.add("editing");
  host.append(element);

  const state = {
    item, nodeId: nodeId ?? "", trigger: item?.trigger ?? "schedule", projectId: item?.target.projectId ?? target?.projectId ?? projectId ?? "",
    options: { harnesses: [], models: [], secretAccounts: [], projects: [], owners: [] }, telegramSenderFields: [],
  };
  let enabled = item?.enabled ?? true;
  let dirty = false;
  let busy = false;
  let current = Promise.resolve();
  let currentTab = "setup";
  const status = makeNode("p", "automation-status");
  status.setAttribute("role", "status");
  status.dataset.testid = "automation-status";

  const say = (message, kind = "info") => showStatus(status, message, kind);
  const endpoint = (suffix = "") => `/api/automations${suffix}${nodeQuery(state.nodeId)}`;
  const url = (suffix = "") => `/api/automations/${encodeURIComponent(state.item.id)}${suffix}${nodeQuery(state.nodeId)}`;
  /** One guarded action at a time; an action asked for while another runs (or from inside it) is ignored. */
  function run(work) {
    if (busy) return undefined;
    busy = true;
    say("");
    current = (async () => {
      try { await work(); } catch (error) { say(errorText(error), "error"); } finally { busy = false; }
    })();
    return current;
  }

  async function loadOwners() {
    const { owners } = await api(`/api/automations/owners?projectId=${encodeURIComponent(state.projectId)}`);
    state.options = { ...state.options, owners };
  }
  /** Reads what the chosen machine offers: its projects, models and accounts. */
  async function loadMachine() {
    const [list, options, { projects }] = await Promise.all([api(endpoint("")), api(endpoint("/options")), api(endpoint("/projects"))]);
    state.projectId ||= projects[0]?.id ?? "";
    state.telegramSenderFields = list.telegramSenderFields;
    state.options = { ...options, projects, owners: state.options.owners };
    await loadOwners();
  }
  try { await loadMachine(); } catch (error) {
    closeAutomationEditor();
    toast.error(errorText(error));
    return;
  }
  if (active !== element) return;

  const ctx = {
    api, say, state, endpoint, url, run, markDirty,
    reload,
    /** The Trigger tab calls this after it makes a new address. */
    showAddress: (_title, secret, bases) => showAddress(secret, bases),
    /** The Context tab reports how many files and skills the automation has, and whether memory is on. */
    setCounts({ files, skills, memory }) {
      const count = files + skills;
      tabButtons.context.textContent = `Context${count ? ` · ${count}` : ""}${memory ? " ●" : ""}`;
    },
    /** The Run tab calls this when the person picks another machine. */
    async setNode(next) {
      state.nodeId = next;
      await loadMachine();
      await Promise.all(Object.values(tabs).map((tab) => tab.onNode?.()));
      markDirty();
    },
  };
  const setup = createSetupTab(ctx, { onPick: pickTrigger, onProject: changeProject });
  const tabs = {
    setup, trigger: createTriggerTab(ctx), run: createRunTab(ctx), context: createContextTab(ctx),
    history: createHistoryTab(ctx, { onAdopt: adopt }),
  };

  // Header
  const title = makeNode("h3", "automation-title");
  const kind = makeNode("span", "automation-kind");
  kind.dataset.testid = "automation-editor-kind";
  const pill = makeNode("span", "automation-pill");
  pill.dataset.testid = "automation-editor-state";
  const runNow = makeButton("Run now", "automation-run-now", () => run(async () => {
    await api(url("/run"), { method: "POST", body: "{}" });
    say("Run started. It shows under History.", "ok");
    if (currentTab === "history") await tabs.history.onShow();
  }), "ghost compact");
  const toggle = makeButton("", "automation-toggle-enabled", () => run(async () => {
    await api(`/api/control-center/automations/${state.item.trigger}/${state.item.id}/enabled`, { method: "PUT", body: JSON.stringify({ enabled: !enabled }) });
    enabled = !enabled;
    state.item = { ...state.item, enabled };
    paintHeader();
    say(enabled ? "Turned on." : "Turned off.", "ok");
  }), "ghost compact");

  const more = makeButton("⋯", "automation-menu", () => togglePop(pop.hidden), "ghost compact");
  more.setAttribute("aria-label", "More actions");
  more.setAttribute("aria-haspopup", "menu");
  const pop = makeNode("div", "automation-menu-pop");
  pop.setAttribute("role", "menu");
  pop.hidden = true;
  const newAddress = makeTwoStepButton({
    label: "New address…", armedLabel: "Make a new address? The old one stops working", testid: "automation-new-address", className: "ghost compact automation-menu-item",
    onConfirm: () => run(async () => {
      const { automation, secret, bases } = await api(url("/regenerate"), { method: "POST", body: "{}" });
      state.item = automation;
      togglePop(false);
      showAddress(secret, bases);
    }),
  });
  const transferOpen = makeButton("Transfer to another machine…", "automation-transfer", () => { togglePop(false); openTransfer(); }, "ghost compact automation-menu-item");
  const remove = makeTwoStepButton({
    label: "Delete automation…", armedLabel: "Delete? This cannot be undone", testid: "automation-delete-confirm", className: "ghost compact danger automation-menu-item",
    onConfirm: () => run(async () => {
      await api(url(), { method: "DELETE" });
      closeAutomationEditor();
      toast("Automation deleted");
    }),
  });
  pop.append(newAddress, transferOpen, remove);
  const menu = makeNode("div", "automation-menu-wrap");
  menu.append(more, pop);
  const actions = makeNode("div", "automation-actions-bar");
  actions.append(runNow, toggle, menu);
  const crumb = makeNode("div", "automation-crumb");
  crumb.append(makeButton("‹ Automations", "automation-back", closeAutomationEditor, "ghost compact"), makeNode("span", "automation-hint", "/"), title, kind, pill);
  const header = makeNode("div", "automation-editor-head");
  header.append(crumb, actions);

  // Transfer panel: a machine to move to, and a two-step confirm that names what changes.
  const transfer = makeNode("div", "automation-callout automation-transfer");
  transfer.hidden = true;
  const destination = makeNode("select");
  destination.dataset.testid = "automation-transfer-machine";
  destination.setAttribute("aria-label", "Machine to move it to");
  const transferNote = makeNode("small", "automation-hint");
  const transferGo = makeTwoStepButton({
    label: "Transfer", armedLabel: "Transfer now?", testid: "automation-transfer-confirm", className: "primary compact",
    onConfirm: () => run(async () => {
      const chosen = state.options.owners.find((owner) => owner.id === destination.value);
      const { automation, secret, bases } = await api(url("/transfer"), { method: "POST", body: JSON.stringify({ nodeId: chosen.id }) });
      state.nodeId = ownerKey(chosen);
      state.item = automation;
      transfer.hidden = true;
      await loadMachine();
      await fillAll();
      if (secret) showAddress(secret, bases);
      else say(`Moved to ${chosen.name}.`, "ok");
    }),
  });
  const transferBody = makeNode("div", "automation-transfer-row");
  transferBody.append(destination, transferGo, makeButton("Cancel", "automation-transfer-cancel", () => { transfer.hidden = true; }));
  transfer.append(makeNode("b", "", "Transfer to another machine"), transferBody, transferNote);

  // Tabs and their bodies
  const strip = makeNode("div", "automation-tabs");
  strip.setAttribute("role", "tablist");
  const tabButtons = Object.fromEntries(TABS.map(([id, label]) => {
    const button = makeNode("button", "automation-tab", label);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.dataset.testid = `automation-tab-${id}`;
    button.addEventListener("click", () => showTab(id));
    strip.append(button);
    return [id, button];
  }));
  const panels = makeNode("div", "automation-panels");
  panels.append(...TABS.map(([id]) => tabs[id].element));

  // Save bar
  const summary = makeNode("span", "automation-summary");
  summary.dataset.testid = "automation-summary";
  const unsaved = makeNode("span", "automation-unsaved", "Unsaved changes");
  unsaved.dataset.testid = "automation-unsaved";
  unsaved.hidden = true;
  const saveButton = makeButton("", "automation-save", save, "primary");
  const saveText = makeNode("div", "automation-savebar-text");
  const summaryLine = makeNode("div", "automation-summary-line");
  summaryLine.append(summary, unsaved);
  saveText.append(summaryLine, status);
  const saveBar = makeNode("div", "automation-savebar");
  saveBar.append(saveText, makeButton("Cancel", "automation-cancel", closeAutomationEditor, "ghost"), saveButton);

  const view = makeNode("div", "automation-view");
  view.append(header, transfer, strip, panels, saveBar);
  const page = makeNode("div", "automation-view automation-address-page");
  page.hidden = true;
  element.replaceChildren(view, page);
  element.addEventListener("click", (event) => { if (!menu.contains(event.target)) togglePop(false); });

  function togglePop(open) {
    pop.hidden = !open;
    more.setAttribute("aria-expanded", String(open));
  }

  function openTransfer() {
    const here = state.nodeId;
    destination.replaceChildren(...state.options.owners.filter((owner) => ownerKey(owner) !== here).map((owner) => new Option(owner.name, owner.id)));
    transferNote.textContent = state.item.trigger === "webhook"
      ? "The address changes: you get a new secret address to copy after the transfer, and the old one stops working."
      : "The automation moves to the machine you pick and runs there from now on.";
    transfer.hidden = false;
  }

  function showTab(id) {
    currentTab = id;
    for (const [tabId, tab] of Object.entries(tabs)) {
      tab.element.hidden = tabId !== id;
      tabButtons[tabId].setAttribute("aria-selected", String(tabId === id));
    }
    Promise.resolve(tabs[id].onShow?.()).catch((error) => say(errorText(error), "error"));
  }

  function paintHeader() {
    const saved = Boolean(state.item);
    title.textContent = state.item?.name ?? "New automation";
    kind.className = `automation-kind ${state.trigger}`;
    kind.textContent = TRIGGERS[state.trigger].badge;
    pill.hidden = actions.hidden = tabButtons.history.hidden = !saved;
    pill.textContent = enabled ? "● On" : "○ Off";
    pill.dataset.on = String(enabled);
    toggle.textContent = enabled ? "Turn off" : "Turn on";
    newAddress.hidden = state.item?.trigger !== "webhook";
    saveButton.textContent = saved ? "Save changes" : "Create automation";
  }

  /** The save bar's one line: what starts it, where it runs and with which model. */
  function paintSummary() {
    unsaved.hidden = !dirty;
    const owner = state.options.owners.find((candidate) => ownerKey(candidate) === state.nodeId);
    const parts = [TRIGGERS[state.trigger].summary, owner?.name];
    // Mid-edit a field can be invalid; the line then simply leaves the model out.
    try { parts.push(tabs.run.read({ projectId: state.projectId, trigger: state.trigger, nodeId: state.nodeId }).model?.modelId); } catch { /* shown when saving */ }
    summary.textContent = parts.filter(Boolean).join(" · ");
  }

  function markDirty() {
    dirty = true;
    paintSummary();
  }

  async function fillAll() {
    const defaults = { projectId: state.projectId, target, trigger: state.trigger };
    await Promise.all(Object.values(tabs).map((tab) => tab.fill(state.item, defaults)));
    dirty = false;
    paintHeader();
    paintSummary();
  }

  /** An automation changed from another place (a sender was allowed): refill unless the person has edits in progress. */
  async function adopt(automation) {
    state.item = automation;
    if (!dirty) await fillAll();
  }

  async function reload() {
    const { automations } = await api(endpoint(""));
    state.item = automations.find((candidate) => candidate.id === state.item.id);
    enabled = state.item.enabled;
    state.trigger = state.item.trigger;
    await fillAll();
  }

  function pickTrigger(next) {
    if (next === state.trigger) return;
    state.trigger = next;
    for (const tab of Object.values(tabs)) tab.onTrigger?.(next);
    paintHeader();
    markDirty();
  }

  function changeProject(next) {
    state.projectId = next;
    return loadOwners().then(() => { for (const tab of Object.values(tabs)) tab.onNode?.(); paintSummary(); });
  }

  function save() {
    // Pressed while another action (a machine change, say) is still running: wait for it, then save.
    if (busy) return current.then(save);
    return run(async () => {
      const shared = { projectId: state.projectId, trigger: state.trigger, nodeId: state.nodeId };
      const input = { trigger: state.trigger, enabled, ...setup.read(), ...tabs.trigger.read(shared), ...tabs.run.read(shared), ...tabs.context.read(shared) };
      const creating = !state.item;
      const missingFile = creating ? tabs.context.missingStaged() : null;
      if (missingFile) throw new Error(missingFile);
      const { automation, secret, bases } = await api(creating ? endpoint() : url(), { method: creating ? "POST" : "PUT", body: JSON.stringify(input) });
      state.item = automation;
      enabled = automation.enabled;
      // Files picked before the automation existed upload now, while the Context tab still holds them.
      if (creating) await tabs.context.uploadStagedFiles(automation);
      await fillAll();
      if (secret !== null) showAddress(secret, bases);
      else say(creating ? "Automation created." : "Changes saved.", "ok");
    });
  }

  /** The address is shown once: right after a webhook is made, switched to, renewed or transferred. */
  function showAddress(secret, bases) {
    const crumbs = makeNode("div", "automation-crumb");
    crumbs.append(makeButton("‹ Automations", "automation-address-back", closeAutomationEditor, "ghost compact"), makeNode("span", "automation-hint", "/"),
      makeNode("h3", "automation-title", `Address for “${state.item.name}”`), makeNode("span", "automation-kind webhook", TRIGGERS.webhook.badge));
    const head = makeNode("div", "automation-editor-head");
    head.append(crumbs);
    const body = makeNode("div", "automation-panels");
    const inner = makeNode("div", "automation-panel");
    inner.append(makeNode("p", "automation-callout", "This is the only time the address is shown. Copy it now and give it to whatever should call it. You can make a new one later from the Trigger tab."));
    if (!bases.length) inner.append(makeNode("p", "automation-hint", "No address is available yet. Join a relay in Settings → Relay, or give this machine a public address, then make a new address from the Trigger tab."));
    for (const base of bases) {
      const address = `${base.base}/${secret}`;
      const line = makeNode("div", "automation-address");
      const code = makeNode("code", "", address);
      code.dataset.testid = "automation-address";
      line.append(makeNode("span", "automation-hint", base.label), code, makeButton("Copy", "automation-address-copy", () => copyText(address, "Webhook address copied")));
      inner.append(line);
    }
    const buttons = makeNode("div", "automation-address-buttons");
    buttons.append(
      makeButton("Done · open the automation", "automation-address-done", () => { page.replaceChildren(); page.hidden = true; view.hidden = false; showTab("setup"); }, "primary"),
      makeButton("Back to Automations", "automation-address-close", closeAutomationEditor, "ghost"),
    );
    inner.append(buttons);
    body.append(inner);
    page.replaceChildren(head, body);
    view.hidden = true;
    page.hidden = false;
  }

  await fillAll();
  showTab("setup");
}
