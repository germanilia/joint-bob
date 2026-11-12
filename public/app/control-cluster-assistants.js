import { api } from "./api.js";
import { currentControlView } from "./control-views.js";
import { confirmAction, toast } from "./shell.js";

/*
 * Cluster assistants in the Assistants tab: the assistants of the clusters the person joined, on whichever machine hosts
 * them. Everyone in the cluster asks them through Bob. On the host, the assistant's creator and the machine's admins in that
 * cluster can change it, delete it and read its audit log (who asked it, who changed it).
 */

const EVENT_WORDS = { "cluster-assistant.created": "Created", "cluster-assistant.asked": "Asked", "cluster-assistant.changed": "Changed", "cluster-assistant.deleted": "Deleted" };

let assistants = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, testid, onClick, className = "ghost compact") {
  const node = el("button", className, label);
  node.type = "button";
  node.dataset.testid = testid;
  node.addEventListener("click", () => Promise.resolve(onClick()).catch((error) => toast.error(error.message)));
  return node;
}

const section = el("section", "control-cluster-asst");
section.dataset.testid = "control-cluster-assistants";
section.hidden = true;
const list = el("div", "control-cluster-asst-list");
section.append(el("h3", "", "Cluster assistants"), el("p", "control-hint", "Made for a cluster and hosted on one of its machines. Everyone in the cluster asks them through Bob; they run on the cluster's subscriptions."), list);
const root = document.querySelector("#controlView-assistants");
root.querySelector(".control-asst-heading").after(section);

// ── Changing one ──────────────────────────────────────────────────────────────────────────────────────────

const editor = el("dialog", "control-secret-dialog");
editor.dataset.testid = "control-cluster-assistant-editor";
const editorTitle = el("h2");
const nameInput = el("input");
nameInput.required = true;
nameInput.maxLength = 100;
nameInput.dataset.testid = "control-cluster-assistant-name";
const instructionsInput = el("textarea");
instructionsInput.rows = 10;
instructionsInput.dataset.testid = "control-cluster-assistant-instructions";
const save = el("button", "primary compact", "Save");
save.type = "submit";
save.dataset.testid = "control-cluster-assistant-save";
const editorActions = el("div", "control-dash-ask-actions");
editorActions.append(button("Cancel", "control-cluster-assistant-cancel", () => editor.close()), save);
const nameField = el("label", "control-secret-field");
nameField.append(el("span", "", "Name"), nameInput);
const instructionsField = el("label", "control-secret-field");
instructionsField.append(el("span", "", "Standing instructions"), instructionsInput);
const editorForm = el("form", "dialog-card control-secret-card control-cluster-asst-card");
editorForm.append(el("span", "eyebrow", "Cluster assistant"), editorTitle, nameField, instructionsField, el("p", "control-hint", "The change is written to the assistant's audit log."), editorActions);
editor.append(editorForm);
let editing = null;

function openEditor(assistant) {
  editing = assistant;
  editorTitle.textContent = `Change ${assistant.name}`;
  nameInput.value = assistant.name;
  instructionsInput.value = assistant.instructions ?? "";
  editor.showModal();
}

editorForm.addEventListener("submit", (event) => {
  event.preventDefault();
  save.disabled = true;
  api(`/api/control-center/cluster-assistants/${encodeURIComponent(editing.id)}`, { method: "PUT", body: JSON.stringify({ name: nameInput.value.trim(), instructions: instructionsInput.value }) })
    .then(() => { editor.close(); toast("Saved"); return load(); })
    .catch((error) => toast.error(error.message))
    .finally(() => { save.disabled = false; });
});

// ── Its audit log ─────────────────────────────────────────────────────────────────────────────────────────

const log = el("dialog", "control-secret-dialog");
log.dataset.testid = "control-cluster-assistant-audit";
const logTitle = el("h2");
const logList = el("div", "control-cluster-asst-log");
const logActions = el("div", "control-dash-ask-actions");
logActions.append(button("Close", "control-cluster-assistant-audit-close", () => log.close()));
const logCard = el("div", "dialog-card control-secret-card control-cluster-asst-card");
logCard.append(el("span", "eyebrow", "Audit log"), logTitle, logList, logActions);
log.append(logCard);
document.body.append(editor, log);

function describe(event) {
  const details = event.details ?? {};
  if (event.eventType === "cluster-assistant.asked") return `${details.askerName ?? "Someone"} asked it${details.purpose ? `: ${details.purpose}` : ""}`;
  if (event.eventType === "cluster-assistant.changed") return `${details.by ?? "Someone"} changed ${[details.renamed ? "its name" : "", details.instructionsChanged ? "its instructions" : ""].filter(Boolean).join(" and ") || "nothing"}`;
  if (event.eventType === "cluster-assistant.created") return `Created as "${details.name ?? ""}"`;
  return EVENT_WORDS[event.eventType] ?? event.eventType;
}

async function openLog(assistant) {
  const { events } = await api(`/api/control-center/cluster-assistants/${encodeURIComponent(assistant.id)}/audit`);
  logTitle.textContent = assistant.name;
  logList.replaceChildren(...(events.length ? events.map((event) => {
    const row = el("div", "control-cluster-asst-event");
    row.dataset.testid = "control-cluster-assistant-event";
    row.append(el("span", "control-hint", new Date(event.createdAt).toLocaleString()), el("span", "", describe(event)));
    return row;
  }) : [el("p", "control-empty", "Nothing yet.")]));
  log.showModal();
}

async function remove(assistant) {
  if (!await confirmAction({ title: `Delete ${assistant.name}?`, message: `It is removed for everyone in "${assistant.clusterName}", with its skill, files and memory.`, confirmLabel: "Delete", destructive: true })) return;
  await api(`/api/control-center/cluster-assistants/${encodeURIComponent(assistant.id)}`, { method: "DELETE" });
  toast("Deleted");
  await load();
}

// ── The list ──────────────────────────────────────────────────────────────────────────────────────────────

function renderRow(assistant) {
  const row = el("article", "control-cluster-asst-row");
  row.dataset.testid = "control-cluster-assistant";
  row.dataset.id = assistant.id;
  const text = el("div", "control-cluster-asst-text");
  text.append(el("b", "", assistant.name), el("span", "control-hint", `Cluster ${assistant.clusterName} · on ${assistant.machineName}${assistant.local ? " (this machine)" : ""}`));
  if (assistant.about) text.append(el("span", "", assistant.about));
  if (assistant.has.length) text.append(el("span", "control-hint", `Has: ${assistant.has.join(", ")}`));
  const actions = el("div", "control-cluster-asst-actions");
  if (assistant.canManage) actions.append(button("Edit", "control-cluster-assistant-edit", () => openEditor(assistant)), button("Audit log", "control-cluster-assistant-log", () => openLog(assistant)), button("Delete", "control-cluster-assistant-delete", () => remove(assistant)));
  row.append(text, actions);
  return row;
}

async function load() {
  assistants = (await api("/api/control-center/cluster-assistants")).assistants;
  section.hidden = !assistants.length;
  list.replaceChildren(...assistants.map(renderRow));
}

const reload = () => { void load().catch((error) => console.warn("Could not list the cluster assistants", error)); };
window.addEventListener("control-view-changed", (event) => { if (event.detail.id === "assistants") reload(); });
window.addEventListener("control-center-changed", () => { if (document.body.classList.contains("view-control") && currentControlView() === "assistants") reload(); });
