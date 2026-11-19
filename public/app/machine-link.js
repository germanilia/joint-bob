import { api } from "./api.js";
import { isNodeAdmin } from "./node-admin.js";
import { confirmAction, toast } from "./shell.js";

/**
 * Settings > Cluster: "Add a machine" makes one link that sets up another machine, and "Use a
 * link" takes any link another machine made. The link bundles a relay pass, twin invitations
 * and cluster invitations; the machine that uses it works through them in order and shows
 * each step, so nobody has to know which tab a link belongs to.
 */

const addReveal = document.getElementById("machineAddReveal");
const addForm = document.getElementById("machineAddForm");
const clustersBox = document.getElementById("machineClusters");
const ownHint = document.getElementById("machineOwnHint");
const createButton = document.getElementById("machineCreateButton");
const result = document.getElementById("machineLinkResult");
const output = document.getElementById("machineLinkOutput");
const summaryLine = document.getElementById("machineLinkSummary");
const notesList = document.getElementById("machineLinkNotes");
const stepsList = document.getElementById("machineLinkSteps");

let options = { clusters: () => [], twinNames: () => [], localName: () => "this machine", hideOtherForms: () => {}, afterChange: async () => {} };

const element = (tag, className, textContent) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
};
const list = (names) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
const host = (origin) => { try { return new URL(origin).host; } catch { return origin; } };

/** What a link will do, as one sentence a person can agree to. */
export function describeMachineLink(summary) {
  const parts = [];
  if (summary.relays.length) parts.push(`joins ${summary.relays.length === 1 ? "the relay" : "the relays"} ${list(summary.relays.map((relay) => host(relay.origin)))}`);
  if (summary.twins.length) parts.push(`becomes a twin of ${list(summary.twins)}`);
  if (summary.clusters.length) parts.push(`joins ${summary.clusters.length === 1 ? "the cluster" : "the clusters"} ${list(summary.clusters)}`);
  return parts.length ? `This machine ${list(parts)}.` : "This link does nothing.";
}

/** The kind of link a person pasted, read from its shape alone. */
export function linkKind(link) {
  let url;
  try { url = new URL(link.trim()); } catch { return "unknown"; }
  if (url.hash.startsWith("#machine-v1.")) return "machine";
  if (url.hash.startsWith("#twin-v2.")) return "twin";
  if (url.pathname === "/enroll") return "relay";
  if (url.hash.startsWith("#v2.")) return "cluster";
  return "unknown";
}

function showAddForm(show) {
  addForm.hidden = !show;
  addReveal.setAttribute("aria-expanded", String(show));
  if (!show) return;
  options.hideOtherForms();
  result.hidden = true;
  output.value = "";
  const twins = options.twinNames();
  ownHint.textContent = `Becomes a twin of ${list([options.localName(), ...twins])}. Twins share everything you own.`;
  clustersBox.replaceChildren(element("legend", "", "Also join"));
  const clusters = options.clusters();
  for (const cluster of clusters) {
    const label = element("label", "checkbox-row");
    const box = element("input");
    Object.assign(box, { type: "checkbox", value: cluster.id, checked: true });
    box.dataset.testid = "machine-cluster-choice";
    label.append(box, ` ${cluster.name}`);
    clustersBox.append(label);
  }
  clustersBox.hidden = !clusters.length;
  addForm.querySelector("input").focus();
}

async function createLink() {
  const own = addForm.querySelector('input[name="machineWhose"]:checked').value === "own";
  const clusterIds = [...clustersBox.querySelectorAll("input:checked")].map((box) => box.value);
  if (!own && !clusterIds.length) throw new Error("Tick at least one cluster for someone else's machine");
  if (own && !await confirmAction({ eyebrow: "Add a machine", title: "Make a link for your own machine?",
    message: "The machine that uses the link becomes your twin: your projects, conversations, files and credentials are shared with it. Send the link only to that machine.", confirmLabel: "Create link" })) return;
  const created = await api("/api/machine-links", { method: "POST", body: JSON.stringify({ own, clusterIds, ...(own ? { confirmOwnedData: true } : {}) }) });
  output.value = created.link;
  const minutes = Math.max(1, Math.round((created.summary.expiresAt - Date.now()) / 60_000));
  summaryLine.textContent = `${describeMachineLink(created.summary).replace(/^This machine/, "The machine that uses it")} It works once, for ${minutes} minutes.`;
  notesList.replaceChildren(...created.notes.map((note) => element("li", "", note)));
  notesList.hidden = !created.notes.length;
  result.hidden = false;
  output.focus(); output.select();
  toast("Link created");
}

function renderSteps(steps) {
  stepsList.replaceChildren(...steps.map((step) => {
    const item = element("li");
    item.dataset.state = step.status;
    item.dataset.testid = "machine-link-step";
    item.append(element("strong", "", step.title), element("small", "", step.detail));
    return item;
  }));
  stepsList.hidden = !steps.length;
}

/** Runs a machine link on this machine after the person agreed to what it does. Returns false when they declined. */
export async function useMachineLink(link) {
  if (!isNodeAdmin()) throw new Error("Only this machine's administrator can add it to other machines");
  const seen = await api("/api/machine-links/inspect", { method: "POST", body: JSON.stringify({ link }) });
  if (seen.issuedHere) throw new Error("This link was made on this machine. Paste it on the machine you are adding.");
  if (seen.expired) throw new Error("This link has expired. Create a new one on the other machine.");
  const twins = seen.summary.twins.length > 0;
  if (!await confirmAction({ eyebrow: `Link from ${seen.summary.issuer}`, title: twins ? "Join your machines?" : "Use this link?",
    message: `${describeMachineLink(seen.summary)}${twins ? " Everything you own here is shared with your twins, and everything they own is shared here." : " Nothing is shared until you choose projects."}`,
    confirmLabel: twins ? "Join and share" : "Join" })) return false;
  renderSteps([]);
  const done = await api("/api/machine-links/use", { method: "POST", body: JSON.stringify({ link, ...(twins ? { confirmOwnedData: true } : {}) }) });
  renderSteps(done.steps);
  const failed = done.steps.filter((step) => step.status === "failed"), waiting = done.steps.filter((step) => step.status === "waiting");
  await options.afterChange();
  if (failed.length) toast.error(`${failed[0].title}: ${failed[0].detail}`);
  else if (waiting.length) toast(waiting[0].detail, 8000);
  else toast(`This machine joined ${seen.summary.issuer}`);
  return true;
}

/**
 * Handles a pasted link that is not a plain cluster invitation. Returns true when it dealt
 * with the link (the caller then leaves the cluster join alone), false for a cluster link.
 */
export async function useOtherLink(link) {
  const kind = linkKind(link);
  if (kind === "machine") { await useMachineLink(link); return true; }
  if (kind === "twin") {
    if (!await confirmAction({ eyebrow: "Twin link", title: "Accept this twin link?", message: "The other machine becomes this machine's twin. Synchronization starts as soon as you accept.", confirmLabel: "Accept and pair" })) return true;
    await api("/api/twins/accept", { method: "POST", body: JSON.stringify({ link, confirmOwnedData: true }) });
    toast("Twin paired");
    await options.afterChange();
    return true;
  }
  if (kind === "relay") {
    await api("/api/relays", { method: "POST", body: JSON.stringify({ link }) });
    toast("Relay added");
    await options.afterChange();
    return true;
  }
  return false;
}

export function clearMachineLinkSteps() { renderSteps([]); }

/** A link pasted while creating this machine's administrator: opens Settings > Cluster and runs it there, where its steps show. */
export async function startWithMachineLink(link) {
  const { openSettings } = await import("./settings.js");
  await openSettings("cluster");
  const input = document.getElementById("clusterJoinLinkInput"), form = document.getElementById("clusterJoinDetails"), reveal = document.getElementById("clusterJoinReveal");
  options.hideOtherForms();
  showAddForm(false);
  form.hidden = false;
  reveal.setAttribute("aria-expanded", "true");
  input.value = link;
  try { await useMachineLink(link); }
  catch (error) { toast.error(error.message); }
}

export function installMachineLinks(next) {
  options = { ...options, ...next };
  addReveal.addEventListener("click", () => showAddForm(addForm.hidden));
  document.getElementById("machineAddCancel").addEventListener("click", () => { showAddForm(false); addReveal.focus(); });
  createButton.addEventListener("click", () => { createLink().catch((error) => toast.error(error.message)); });
  document.getElementById("machineLinkCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(output.value); toast("Link copied"); }
    catch (error) { toast.error(error.message || "Could not copy the link"); }
  });
  for (const choice of addForm.querySelectorAll('input[name="machineWhose"]')) choice.addEventListener("change", () => { result.hidden = true; });
  addForm.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); showAddForm(false); addReveal.focus(); }
  });
  return { hide: () => showAddForm(false) };
}
