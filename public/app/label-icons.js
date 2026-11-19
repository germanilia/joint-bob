import { harnessOption } from "../harness-metadata.js";
import { api } from "./api.js";
import { fillModelOptions, selectedModel } from "./git-reviewer-options.js";
import { state } from "./state.js";
import { toast } from "./shell.js";

/**
 * Settings → Labels: one editable row per label, each with an icon the user can type, leave empty (the label then
 * shows as text), or ask an agent to pick. The textarea (Edit the labels as text) holds the same list and is what
 * Settings saves, so a change in a row writes it and a change in the textarea redraws the rows.
 */
const labelsField = document.querySelector("#settingsConversationLabels");
const rows = document.querySelector("#settingsLabelRows");
const harnessSelect = document.querySelector("#settingsLabelIconHarness");
const modelSelect = document.querySelector("#settingsLabelIconModel");
const modelLabel = document.querySelector("#settingsLabelIconModelLabel");
const effortSelect = document.createElement("select");
let runnableHarnesses = [];
let models = [];
let draft = {};

const labelNames = () => [...new Set(labelsField.value.split("\n").map((label) => label.trim()).filter(Boolean))];

function pickedHarness() {
  return runnableHarnesses.find((harness) => harness.id === harnessSelect.value);
}

function renderModels() {
  const harness = pickedHarness();
  modelLabel.hidden = !harness;
  if (harness) fillModelOptions(harness, models, modelSelect, effortSelect);
}

async function renderHarnessOptions() {
  const chosen = harnessSelect.value;
  if (!models.length) {
    try {
      const [harnessBody, modelBody] = await Promise.all([api("/api/harnesses"), api("/api/models")]);
      runnableHarnesses = harnessBody.harnesses.filter((harness) => harness.runtimeConfigured && harness.ready);
      models = modelBody.models;
    } catch (error) {
      toast.error(error.message);
    }
  }
  harnessSelect.replaceChildren(new Option("Automatic (default agent)", ""), ...runnableHarnesses.map(harnessOption));
  harnessSelect.value = runnableHarnesses.some((harness) => harness.id === chosen) ? chosen : "";
  renderModels();
}

harnessSelect.addEventListener("change", renderModels);

function pickedModel() {
  const { provider, modelId } = selectedModel(modelSelect);
  return { ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}) };
}

/** The textarea is the saved list: rewrite it from the rows and let Settings autosave see the change. */
function writeText() {
  labelsField.value = [...rows.querySelectorAll(".label-icon-name")].map((field) => field.value.trim()).filter(Boolean).join("\n");
  labelsField.dispatchEvent(new Event("input", { bubbles: true }));
}

function row(first) {
  let label = first;
  const item = document.createElement("div");
  item.className = "label-icon-row";
  item.dataset.testid = "label-icon-row";
  const name = document.createElement("input");
  name.className = "label-icon-name";
  name.maxLength = 80;
  name.autocomplete = "off";
  name.placeholder = "Label";
  name.value = label;
  name.dataset.testid = "label-name-input";
  name.setAttribute("aria-label", "Label name");
  name.addEventListener("input", () => {
    const renamed = name.value.trim();
    if (renamed === label) return;
    if (draft[label]) { draft[renamed] = draft[label]; delete draft[label]; }
    label = renamed;
    input.setAttribute("aria-label", `Icon for ${label || "this label"}`);
    writeText();
  });
  const input = document.createElement("input");
  input.className = "label-icon-input";
  input.maxLength = 16;
  input.autocomplete = "off";
  input.placeholder = "None";
  input.value = draft[label] || "";
  input.dataset.testid = "label-icon-input";
  input.setAttribute("aria-label", `Icon for ${label}`);
  input.addEventListener("input", () => { draft[label] = input.value.trim(); });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost";
  remove.textContent = "Remove";
  remove.dataset.testid = "label-remove";
  remove.setAttribute("aria-label", "Remove label");
  remove.addEventListener("click", () => { delete draft[label]; item.remove(); writeText(); });
  const generate = document.createElement("button");
  generate.type = "button";
  generate.className = "ghost";
  generate.textContent = "Generate";
  generate.dataset.testid = "label-icon-generate";
  generate.setAttribute("aria-label", `Generate an icon for ${label}`);
  generate.addEventListener("click", async () => {
    if (!label) { name.focus(); toast.error("Name the label first."); return; }
    generate.disabled = true;
    generate.textContent = "Generating…";
    try {
      const body = await api("/api/settings/label-icon", { method: "POST", body: JSON.stringify({ label, ...(harnessSelect.value ? { harnessId: harnessSelect.value, ...pickedModel() } : {}) }) });
      draft[label] = body.icon;
      input.value = body.icon;
      // Settings saves as fields change; a generated icon is a change like a typed one.
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (error) {
      toast.error(error.message);
    } finally {
      generate.disabled = false;
      generate.textContent = "Generate";
    }
  });
  item.append(name, input, generate, remove);
  return item;
}

function render() {
  void renderHarnessOptions();
  const names = labelNames();
  rows.replaceChildren(...names.map(row));
}

document.querySelector("#settingsLabelAdd").addEventListener("click", () => {
  const added = row("");
  rows.append(added);
  added.querySelector(".label-icon-name").focus();
});

labelsField.addEventListener("change", render);
labelsField.addEventListener("blur", render);

export function loadLabelIcons(icons) {
  draft = { ...icons };
  render();
}

/** Icons for the labels now in the textarea; a blank icon means the label shows as text. */
export function labelIconsValue() {
  return Object.fromEntries(labelNames().filter((label) => draft[label]).map((label) => [label, draft[label]]));
}
