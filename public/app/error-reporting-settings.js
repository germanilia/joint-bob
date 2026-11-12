// Settings → Notifications → Send errors to ntfy. Saved as it changes, node-local.
import { api } from "./api.js";
import { toast } from "./shell.js";
import { autosaveFields, invalidSetting, settingsAutosave } from "./settings-autosave.js";

const field = (id) => document.getElementById(id);
const enabledInput = field("errorReportingEnabled");
const options = field("errorReportingOptions");
const channels = {
  client: { enabled: field("errorReportingClientEnabled"), destination: field("errorReportingClientDestination"), service: field("errorReportingClientService"), topic: field("errorReportingClientTopic") },
  backend: { enabled: field("errorReportingBackendEnabled"), destination: field("errorReportingBackendDestination"), service: field("errorReportingBackendService"), topic: field("errorReportingBackendTopic") },
};
const sameRow = field("errorReportingSameRow");
const sameInput = field("errorReportingSameDestination");
const saveButton = field("errorReportingSaveButton");

let services = [];
let saved = null;

function syncVisibility() {
  options.hidden = !enabledInput.checked;
  const client = channels.client.enabled.checked;
  const backend = channels.backend.enabled.checked;
  channels.client.destination.hidden = !client;
  sameRow.hidden = !(client && backend);
  channels.backend.destination.hidden = !backend || (client && sameInput.checked);
}

function renderServices(select, preferredId) {
  const choices = services.map((service) => new Option(`${service.name} — ${service.url}`, service.id));
  if (preferredId && !services.some((service) => service.id === preferredId)) choices.unshift(new Option("Removed server; choose another", preferredId));
  if (!choices.length) choices.push(new Option("Add an ntfy service above first", ""));
  select.replaceChildren(...choices);
  select.value = preferredId || services.find((service) => service.isDefault)?.id || services[0]?.id || "";
}

function render() {
  for (const [name, channel] of Object.entries(channels)) renderServices(channel.service, channel.service.value || saved?.[name].serviceId);
}

function fill(settings) {
  saved = settings;
  enabledInput.checked = settings.enabled;
  sameInput.checked = settings.sameDestination;
  for (const [name, channel] of Object.entries(channels)) {
    channel.enabled.checked = settings[name].enabled;
    channel.topic.value = settings[name].topic;
    renderServices(channel.service, settings[name].serviceId);
  }
  syncVisibility();
}

/** Keeps the server pickers in step with the ntfy services list above. */
export function syncErrorReportingServices(list) {
  services = list;
  render();
}

export async function loadErrorReportingSettings() {
  try { fill(await api("/api/error-reporting")); } catch (error) { toast.error(error.message); }
}

for (const input of [enabledInput, sameInput, channels.client.enabled, channels.backend.enabled]) input.addEventListener("change", syncVisibility);

/** Saves as the fields change (settings-autosave.js); a failure is thrown for the Settings save line. */
async function saveErrorReporting() {
  if (!saved) throw invalidSetting("Error reporting is still loading");
  const destination = (channel) => ({ enabled: channel.enabled.checked, serviceId: channel.service.value || null, topic: channel.topic.value.trim() });
  // Turning it on takes a few steps; until a server and topic are chosen the line says what is missing (as the node would).
  if (enabledInput.checked) {
    if (!channels.client.enabled.checked && !channels.backend.enabled.checked) throw invalidSetting("Choose client errors, backend errors, or both");
    for (const [name, label] of [["client", "Client errors"], ["backend", "Backend errors"]]) {
      if (!channels[name].enabled.checked) continue;
      const source = destination(name === "backend" && sameInput.checked && channels.client.enabled.checked ? channels.client : channels[name]);
      if (!source.serviceId) throw invalidSetting(`${label} need a saved ntfy server`);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(source.topic)) throw invalidSetting(`${label} need a topic of 1 to 64 letters, digits, - or _`);
    }
  }
  // The answer is kept, not filled back in: a topic still being typed must not be reset.
  saved = await api("/api/error-reporting", {
    method: "PUT",
    body: JSON.stringify({ enabled: enabledInput.checked, sameDestination: sameInput.checked, client: destination(channels.client), backend: destination(channels.backend) }),
  });
}

settingsAutosave().channel("error-reporting", saveErrorReporting);
autosaveFields(field("errorReportingEnabled").closest("fieldset"), "error-reporting", { accept: (target) => target.matches("input, select") });
// The button is hidden: error reporting saves as it changes. It stays for anything that presses it.
saveButton.addEventListener("click", () => { settingsAutosave().schedule("error-reporting", 0); });
