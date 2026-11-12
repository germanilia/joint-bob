import { api } from "./api.js";
import { toast } from "./shell.js";

/*
 * What an assistant's setup asks the person for. "Enter it" on Bob's message opens this box; the values go straight to
 * the server, which keeps them in Secrets attached to the assistant. They never pass through the chat or the agent.
 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const dialog = el("dialog", "control-secret-dialog");
dialog.dataset.testid = "control-secret-dialog";
dialog.setAttribute("aria-labelledby", "controlSecretTitle");
const title = Object.assign(el("h2"), { id: "controlSecretTitle" });
const why = el("p", "control-hint");
why.dataset.testid = "control-secret-why";
const fields = el("div", "control-secret-fields");
const note = el("p", "control-hint", "Saved to Secrets and attached to this assistant. The agent uses it by name and never sees the value.");
const cancel = el("button", "ghost compact", "Cancel");
cancel.type = "button";
cancel.addEventListener("click", () => dialog.close());
const save = el("button", "primary compact", "Save");
save.type = "submit";
save.dataset.testid = "control-secret-save";
const actions = el("div", "control-dash-ask-actions");
actions.append(cancel, save);
const form = el("form", "dialog-card control-secret-card");
form.append(el("span", "eyebrow", "Assistant setup"), title, why, fields, note, actions);
dialog.append(form);
document.body.append(dialog);
dialog.addEventListener("close", () => fields.replaceChildren());

let open = null;

window.addEventListener("control-secret-request", (event) => {
  open = event.detail;
  const { request } = open;
  title.textContent = `${request.assistantName} needs ${request.label}`;
  why.textContent = request.why;
  fields.replaceChildren(...request.names.map((name) => {
    const label = el("label", "control-secret-field");
    const input = el("input");
    input.type = "password";
    input.name = name;
    input.required = true;
    input.autocomplete = "off";
    input.dataset.testid = "control-secret-input";
    label.append(el("span", "", name), input);
    return label;
  }));
  dialog.showModal();
  fields.querySelector("input").focus();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const values = Object.fromEntries([...fields.querySelectorAll("input")].map((input) => [input.name, input.value]));
  save.disabled = true;
  api(`/api/control-center/assistant-setup/secrets/${encodeURIComponent(open.request.id)}`, { method: "POST", body: JSON.stringify({ messageId: open.messageId, values }) })
    .then(() => {
      dialog.close();
      toast("Saved. The setup goes on.");
      window.dispatchEvent(new CustomEvent("control-center-changed"));
    })
    .catch((error) => toast.error(error.message))
    .finally(() => { save.disabled = false; });
});
