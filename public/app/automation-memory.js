// Automation editor → Context → Memory. One switch turns the automation's persistent Markdown note
// on. When on, the note can be edited, previewed, uploaded, downloaded and cleared. Saving checks
// that the agent did not change the note since it was read; a draft is never overwritten silently.
import { api } from "./api.js";
import { renderMarkdown } from "../markdown.js";
import { makeButton, makeNode, makeTwoStepButton } from "./relay-ui.js";
import { errorText, makeSegmented, saveBlob } from "./automation-ui.js";

const MAX_CHARACTERS = 200000;

/** `url(suffix)` addresses the current automation, `run(work)` runs one guarded action. */
export function createAutomationMemory({ url, run, say, onEnabled }) {
  let revision = "";

  const element = makeNode("div", "automation-memory");
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.dataset.testid = "automation-memory-enabled-toggle";
  const toggleText = makeNode("span");
  toggleText.append(
    makeNode("strong", "", "Persistent memory"),
    makeNode("span", "settings-hint", "The agent reads this note at the start of every run and adds what it learns from feedback and problems. You can edit it here."),
  );
  const toggle = makeNode("label", "checkbox-row automation-option");
  toggle.append(enabled, toggleText);

  const on = makeNode("div", "automation-memory-on");
  const modes = makeNode("div");
  const upload = document.createElement("input");
  upload.type = "file";
  upload.accept = ".md,text/markdown";
  upload.hidden = true;
  upload.dataset.testid = "automation-memory-upload-input";
  const actions = makeNode("div", "relay-row-actions");
  actions.append(
    makeButton("Upload .md", "automation-memory-upload-button", () => upload.click()),
    upload,
    makeButton("Download", "automation-memory-download-button", () => saveBlob("MEMORY.md", new Blob([content.value], { type: "text/markdown;charset=utf-8" }))),
    makeTwoStepButton({ label: "Clear", armedLabel: "Erase it?", testid: "automation-memory-reset-button", onConfirm: () => run(async () => { await write(""); say("Memory reset.", "ok"); }) }),
  );
  const head = makeNode("div", "relay-head");
  head.append(modes, actions);

  const content = document.createElement("textarea");
  content.dataset.testid = "automation-memory-content-input";
  content.maxLength = MAX_CHARACTERS;
  content.spellcheck = false;
  content.placeholder = "Empty. The agent adds notes here as it learns.";
  content.setAttribute("aria-label", "Markdown memory");
  const preview = makeNode("div", "automation-preview");
  preview.dataset.testid = "automation-memory-preview";
  preview.hidden = true;

  const size = makeNode("span", "settings-hint");
  const buttons = makeNode("div", "relay-row-actions");
  buttons.append(
    makeButton("Discard", "automation-memory-discard-button", () => void run(read)),
    makeButton("Save memory", "automation-memory-save-button", () => void run(async () => { await write(content.value); say("Memory saved.", "ok"); }), "primary compact"),
  );
  const foot = makeNode("div", "relay-head");
  foot.append(size, buttons);
  on.append(head, content, preview, foot);

  const off = makeNode("div", "automation-empty");
  off.dataset.testid = "automation-memory-off";
  off.hidden = true;
  off.append(makeNode("strong", "", "Memory is off"), makeNode("span", "settings-hint", "Each run starts with no notes from earlier runs. Turn it on to let the agent keep what it learns."));
  element.append(toggle, on, off);

  function show(memory) {
    enabled.checked = memory.enabled;
    content.value = memory.content;
    revision = memory.revision;
    on.hidden = !memory.enabled;
    off.hidden = memory.enabled;
    showMode("edit");
    updateSize();
    onEnabled(memory.enabled);
  }

  function updateSize() {
    size.textContent = `${(new Blob([content.value]).size / 1000).toFixed(1)} kB of ${MAX_CHARACTERS / 1000} kB`;
  }

  function showMode(mode) {
    content.hidden = mode !== "edit";
    preview.hidden = mode === "edit";
    if (mode === "preview") renderMarkdown(preview, content.value);
  }

  const read = async () => show(await api(url("/memory")));
  const write = async (text) => {
    const shown = content.value;
    const memory = await api(url("/memory"), { method: "PUT", body: JSON.stringify({ content: text, expectedRevision: revision }) });
    revision = memory.revision;
    // Whatever was typed while this saved stays in the editor.
    if (content.value === shown) content.value = text;
    updateSize();
  };

  // Not run through the shared `run` lock: the reload would otherwise drop a Save click made right after.
  async function setEnabled() {
    try {
      await api(url("/memory"), { method: "POST", body: JSON.stringify({ action: "enable", enabled: enabled.checked }) });
      await read();
    } catch (error) { say(errorText(error), "error"); }
  }

  async function uploadFile(file) {
    if (!file.name.toLowerCase().endsWith(".md")) throw new Error("Choose a Markdown file ending in .md");
    const text = await file.text();
    if (!enabled.checked) { await api(url("/memory"), { method: "POST", body: JSON.stringify({ action: "enable", enabled: true }) }); await read(); }
    await write(text);
    say("Memory uploaded.", "ok");
  }

  modes.append(makeSegmented([{ value: "edit", label: "Edit", testid: "automation-memory-mode-edit" }, { value: "preview", label: "Preview", testid: "automation-memory-mode-preview" }], "edit", showMode));
  enabled.addEventListener("change", () => void setEnabled());
  content.addEventListener("input", updateSize);
  upload.addEventListener("change", () => {
    const [file] = upload.files;
    upload.value = "";
    if (file) void run(() => uploadFile(file));
  });

  return { element, open: (automation) => (automation ? read() : onEnabled(false)) };
}
