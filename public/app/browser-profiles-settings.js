// Settings → Browser → Profiles: every browser profile this machine may see across the
// cluster. Logins stay on the machine that owns a profile; changes go to that machine.
// The list fits the section and pages (list-pager.js); a filter box and a machine dropdown narrow it.
import { api } from "./api.js";
import { describeShare, shareGrantPayload, shareGrantValue, shareScopeLabel } from "./browser-profile-access.js";
import { fuzzyMatch } from "./fuzzy.js";
import { createListPager, rowActions } from "./list-pager.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

let loading = false;
let targets = { localNodeId: null, nodes: [], clusters: [], workspaces: [] };
let profiles = [];

const container = () => document.querySelector("#browserProfileDirectory");
const statusLine = () => document.querySelector("#browserProfileDirectoryStatus");
const filters = () => document.querySelector("#browserProfileFilters");
const filterInput = () => document.querySelector("#browserProfileFilter");
const machineSelect = () => document.querySelector("#browserProfileMachine");
const pager = createListPager({ list: container(), prefix: "browser-profile", label: "Browser profile pages", render });
filterInput().addEventListener("input", () => { pager.reset(); render(); });
machineSelect().addEventListener("change", () => { pager.reset(); render(); });

function names(profile) {
  const machine = (id) => targets.nodes.find((node) => node.id === id)?.name ?? (id === profile.nodeId ? profile.nodeName : id);
  return {
    machine,
    project: (id) => state.projects.find((project) => project.id === id)?.name ?? id,
    conversation: (_projectId, id) => `${id.slice(0, 8)}…`,
    workspace: (id) => targets.workspaces.find((workspace) => workspace.id === id)?.label ?? id,
    cluster: (id) => targets.clusters.find((cluster) => cluster.id === id)?.name ?? id,
  };
}

export async function loadBrowserProfileDirectory() {
  if (loading) return;
  loading = true;
  statusLine().textContent = "Loading browser profiles…";
  try {
    const [directory, shareTargets] = await Promise.all([api("/api/browser/directory"), api("/api/browser/share-targets")]);
    targets = shareTargets;
    profiles = directory.profiles;
    // The status line sits under the list, so it is settled before the list measures its room.
    statusLine().textContent = directory.unavailableNodes.length
      ? `Not shown: ${directory.unavailableNodes.map((node) => `${node.name} (${node.reason})`).join("; ")}.`
      : "";
    fillMachines();
    render();
  } catch (error) { statusLine().textContent = `Browser profiles unavailable: ${error.message}`; }
  finally { loading = false; }
}

function text(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = content;
  return element;
}

function button(label, testid, onClick, extra = "") {
  const element = document.createElement("button");
  element.type = "button"; element.className = `ghost compact${extra}`; element.textContent = label; element.dataset.testid = testid;
  element.addEventListener("click", onClick);
  return element;
}

/** Every machine that holds a profile, so the dropdown never offers an empty choice. */
function fillMachines() {
  const select = machineSelect(), chosen = select.value;
  const machines = new Map(profiles.map((profile) => [profile.nodeId, names(profile).machine(profile.nodeId)]));
  select.replaceChildren(new Option("All machines", ""), ...[...machines].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => new Option(name, id)));
  select.value = machines.has(chosen) ? chosen : "";
}

const siteNames = (profile) => (profile.sites ?? []).map((site) => site.replace(/^https?:\/\//, ""));

function render() {
  filters().hidden = !profiles.length;
  const query = filterInput().value.trim(), machine = machineSelect().value;
  const shown = profiles.filter((profile) => (!machine || profile.nodeId === machine)
    && (!query || fuzzyMatch(query, profile.label, names(profile).machine(profile.nodeId), siteNames(profile).join(" ")) !== null));
  const rows = pager.slice(shown).map(profileRow);
  container().replaceChildren(...(rows.length ? rows : [text("p", "long-list-empty", profiles.length
    ? "No profiles match. Clear the filter or choose All machines."
    : "No browser profiles yet. Agents create one the first time a conversation opens a browser.")]));
  pager.update();
}

/** One row of fixed height: name and who may use it, machine, sites, state, actions. */
function profileRow(profile) {
  const row = document.createElement("div"); row.className = "long-list-row browser-profile-row"; row.dataset.testid = "browser-profile-directory-row"; row.dataset.profileId = profile.id;
  const label = names(profile), machine = label.machine(profile.nodeId);
  const shares = profile.grants?.length ? profile.grants.map((grant) => describeShare(grant, label)).join("; ") : "Not usable by any conversation";
  const main = document.createElement("span"); main.className = "long-row-main";
  const name = text("strong", "", profile.label); name.title = profile.label;
  const who = text("small", "", `${shareScopeLabel(profile.grants ?? [])} · ${shares}`); who.title = who.textContent;
  main.append(name, who);
  const sites = siteNames(profile);
  const where = document.createElement("span"); where.className = "long-row-where";
  const machineName = text("span", "long-row-machine", machine); machineName.dataset.testid = "browser-profile-directory-machine";
  const siteList = text("span", "long-row-sites", sites.length ? sites.join(", ") : "No sites yet"); siteList.title = sites.length ? `Sites: ${sites.join(", ")}` : "No sites yet";
  where.append(machineName, siteList);
  const holderText = profile.holder ? (profile.holder.inUse ? "In use by another conversation" : `Open in a conversation on ${label.machine(profile.holder.appNodeId)}`) : "Idle";
  const tag = text("span", `long-row-tag${profile.holder ? " on" : ""}`, profile.holder ? (profile.holder.inUse ? "In use" : `Open on ${label.machine(profile.holder.appNodeId)}`) : "Idle");
  tag.title = holderText; tag.dataset.testid = "browser-profile-directory-state";
  row.append(main, where, tag);
  if (!profile.canManage) {
    const note = text("span", "long-row-note", "Read-only"); note.title = "Shared with this machine · read-only";
    row.append(note);
    return row;
  }
  const { actions, more } = rowActions([
    button("Share…", "browser-profile-share", () => void openShareDialog(profile).catch((error) => toast.error(error.message))),
    button("Rename", "browser-profile-rename", () => startRename(row, profile)),
    profile.holder ? button("Close there", "browser-profile-close", () => void closeProfile(profile)) : button("Delete", "browser-profile-delete", () => void deleteProfile(profile), " danger"),
  ], `Actions for ${profile.label}`);
  more.dataset.testid = "browser-profile-more";
  row.append(actions, more);
  return row;
}

async function change(profile, body, success) {
  await api(`/api/browser/directory/${encodeURIComponent(profile.nodeId)}/${encodeURIComponent(profile.id)}`, { method: "POST", body: JSON.stringify(body) });
  if (success) toast(success);
}

/** The name box takes the name's place in the row, so the row keeps its height; Escape puts the name back. */
function startRename(row, profile) {
  if (row.querySelector(".browser-profile-rename")) return;
  const form = document.createElement("form"); form.className = "browser-profile-rename";
  const input = document.createElement("input"); input.value = profile.label; input.maxLength = 80; input.required = true; input.setAttribute("aria-label", "Profile name"); input.dataset.testid = "browser-profile-rename-input";
  const save = document.createElement("button"); save.type = "submit"; save.className = "ghost compact"; save.textContent = "Save";
  form.append(input, save);
  const main = row.querySelector(".long-row-main");
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation();
    form.replaceWith(main);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      try { await change(profile, { label: input.value.trim() }, "Profile renamed"); await loadBrowserProfileDirectory(); }
      catch (error) { toast.error(error.message); }
    })();
  });
  main.replaceWith(form); input.focus(); input.select();
}

async function closeProfile(profile) {
  const confirmed = await confirmAction({ eyebrow: "Browser profile", title: `Close ${profile.label}?`, message: "Its browser closes in the conversation that has it open, and that conversation's agent stops using it. Its saved logins stay. Any conversation it is shared with can then open it.", confirmLabel: "Close browser", destructive: true });
  if (!confirmed) return;
  try { await change(profile, { close: true }, `${profile.label} closed`); } catch (error) { toast.error(error.message); }
  await loadBrowserProfileDirectory();
}

async function deleteProfile(profile) {
  const confirmed = await confirmAction({ eyebrow: "Browser profile", title: `Delete ${profile.label}?`, message: "Its saved logins are deleted from its machine. This cannot be undone.", confirmLabel: "Delete profile", destructive: true });
  if (!confirmed) return;
  try { await change(profile, { delete: true }, `${profile.label} deleted`); } catch (error) { toast.error(error.message); }
  await loadBrowserProfileDirectory();
}

/** Options offered here plus every share the profile already has, so unchecking any of them removes it. */
function shareOptions(profile) {
  const label = names(profile);
  const options = [
    ...targets.clusters.map((cluster) => ({ group: "Clusters", grant: { scope: "cluster", clusterId: cluster.id } })),
    ...targets.nodes.map((node) => ({ group: "Machines", grant: { scope: "node", nodeId: node.id } })),
    ...targets.workspaces.map((workspace) => ({ group: `Workspaces on ${label.machine(targets.localNodeId)}`, grant: { scope: "workspace", workspaceId: workspace.id, nodeId: targets.localNodeId } })),
    ...state.projects.map((project) => ({ group: "Projects", grant: { scope: "project", projectId: project.id } })),
  ];
  for (const grant of profile.grants ?? []) {
    if (!options.some((option) => shareGrantValue(option.grant) === shareGrantValue(grant))) options.push({ group: "Current shares", grant });
  }
  return options.map((option) => ({ ...option, label: describeShare(option.grant, label) }));
}

async function openShareDialog(profile) {
  const current = new Set((profile.grants ?? []).map(shareGrantValue));
  const options = shareOptions(profile);
  const dialog = document.createElement("dialog"); dialog.className = "secret-sharing-dialog"; dialog.dataset.testid = "browser-profile-share-dialog";
  const form = document.createElement("form"); form.method = "dialog"; form.className = "dialog-card secret-sharing-card";
  const hint = text("p", "", `Logins stay on ${names(profile).machine(profile.nodeId)}; shared conversations anywhere open it there. Only one conversation can have it open at a time.`);
  hint.id = "browser-profile-share-hint"; dialog.setAttribute("aria-describedby", hint.id);
  form.append(text("h3", "", `Share ${profile.label}`), hint);
  for (const group of [...new Set(options.map((option) => option.group))]) {
    const fieldset = document.createElement("fieldset");
    fieldset.append(text("legend", "", group));
    for (const option of options.filter((candidate) => candidate.group === group)) {
      const row = document.createElement("label"); row.className = "checkbox-row";
      const input = document.createElement("input"); input.type = "checkbox"; input.dataset.testid = "browser-profile-share-option"; input.dataset.value = shareGrantValue(option.grant);
      input.checked = current.has(input.dataset.value);
      row.append(input, document.createTextNode(option.label)); fieldset.append(row);
    }
    form.append(fieldset);
  }
  const actions = document.createElement("div"); actions.className = "dialog-actions";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel"; cancel.addEventListener("click", () => dialog.close());
  const save = document.createElement("button"); save.type = "submit"; save.className = "primary"; save.textContent = "Save sharing"; save.dataset.testid = "browser-profile-share-save";
  actions.append(cancel, save); form.append(actions); dialog.append(form); document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const chosen = new Set([...form.querySelectorAll("input[type=checkbox]:checked")].map((input) => input.dataset.value));
      const byValue = new Map(options.map((option) => [shareGrantValue(option.grant), option.grant]));
      const added = [...chosen].filter((value) => !current.has(value)).map((value) => byValue.get(value));
      const removed = [...current].filter((value) => !chosen.has(value)).map((value) => byValue.get(value));
      if (!added.length && !removed.length) { dialog.close(); return; }
      if (added.some((grant) => grant.scope === "cluster" || grant.scope === "node")) {
        const confirmed = await confirmAction({ eyebrow: "Share browser profile", title: `Share ${profile.label} widely?`, message: "Every conversation in the chosen machines or clusters could open it and use its signed-in websites.", confirmLabel: "Save sharing" });
        if (!confirmed) return;
      }
      save.disabled = true;
      try {
        for (const grant of added) await change(profile, { grant: shareGrantPayload(grant) });
        for (const grant of removed) await change(profile, { revoke: shareGrantPayload(grant) });
        dialog.close();
        toast("Browser profile sharing saved");
      } catch (error) { toast.error(error.message); }
      finally { save.disabled = false; await loadBrowserProfileDirectory(); }
    })();
  });
  dialog.showModal(); cancel.focus();
}
