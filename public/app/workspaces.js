import { api } from "./api.js";
import { openBudgetDialog, workspaceBudgetTarget } from "./budget-dialog.js";
import { isNodeAdmin } from "./node-admin.js";
import { elements } from "./elements.js";
import { createListPager, rowActions } from "./list-pager.js";
import { fillProjectBases } from "./project-forms.js";
import { openSecretScope } from "./secrets.js";
import { confirmAction, toast } from "./shell.js";
import { shared, state } from "./state.js";
import { installWorkspaceCreationSharing, openWorkspaceSharing, resetWorkspaceCreationSharing, workspaceCreationSharing } from "./workspace-sharing.js";

export async function loadWorkspaces() {
  shared.workspaces = (await api("/api/workspaces")).workspaces;
  renderWorkspaces();
  fillWorkspaceSelect();
}

/** A shared workspace names the node it comes from: two nodes can both have "Contigos". */
export function workspaceName(workspace) {
  return workspace.source ? `${workspace.label} · ${workspace.source.name}` : workspace.label;
}

/** Keeps the create-project picker in step with the workspaces configured in Settings. */
function fillWorkspaceSelect() {
  const previous = elements.projectWorkspaceInput.value;
  elements.projectWorkspaceInput.replaceChildren();
  for (const workspace of shared.workspaces) {
    const option = document.createElement("option");
    option.value = workspace.id;
    option.textContent = workspaceName(workspace);
    elements.projectWorkspaceInput.append(option);
  }
  if (!shared.workspaces.length) {
    const option = document.createElement("option");
    option.value = "";
    option.disabled = true;
    option.textContent = "Create a workspace in Settings > Workspaces first";
    elements.projectWorkspaceInput.append(option);
  }
  elements.projectWorkspaceInput.value = shared.workspaces.some((workspace) => workspace.id === previous) ? previous : shared.workspaces[0]?.id ?? "";
}

// The list fits the section and pages (list-pager.js); `revealWorkspaceId` turns to a new workspace's page once.
const workspacePager = createListPager({ list: elements.workspaceList, prefix: "workspace", label: "Workspace pages", render: renderWorkspaces });
let revealWorkspaceId = null;

function renderWorkspaces() {
  const rows = workspacePager.slice(shared.workspaces, shared.workspaces.findIndex((workspace) => workspace.id === revealWorkspaceId)).map(workspaceRow);
  revealWorkspaceId = null;
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "project-type-empty long-list-empty";
    empty.textContent = "No workspaces yet. Add one to choose where new projects land.";
    rows.push(empty);
  }
  elements.workspaceList.replaceChildren(...rows);
  workspacePager.update();
}

/** One row of fixed height: the name, its folder, and its actions (behind ⋯ on a phone). */
function workspaceRow(workspace) {
  const row = document.createElement("div");
  row.className = "project-type-row long-list-row";
  row.dataset.testid = "workspace-row";

  const main = document.createElement("span");
  main.className = "long-row-main";
  const name = document.createElement("strong");
  name.textContent = workspaceName(workspace);
  name.title = name.textContent;
  main.append(name);

  const folder = document.createElement("code");
  folder.className = "long-row-folder";
  folder.textContent = `/${workspace.id}`;
  folder.title = folder.textContent;

  const action = (label, testid, onClick, extra = "") => {
    const control = document.createElement("button");
    control.type = "button";
    control.className = `ghost compact${extra}`;
    control.textContent = label;
    control.dataset.testid = testid;
    control.addEventListener("click", onClick);
    return control;
  };
  const buttons = [action("Secrets", "workspace-secrets-button", () => openSecretScope("workspace", workspace.id, workspace.label).catch((error) => toast.error(error.message)))];
  if (!workspace.source) buttons.push(action("Share", "workspace-share-button", () => openWorkspaceSharing(workspace).catch((error) => toast.error(error.message))));
  if (isNodeAdmin() && !workspace.source) buttons.push(action("Budget", "workspace-budget-button", () => openBudgetDialog(workspaceBudgetTarget(workspace)).catch((error) => toast.error(error.message))));
  buttons.push(action("Delete", "workspace-delete-button", async () => {
    const confirmed = await confirmAction({
      eyebrow: "Delete workspace",
      title: `Delete the "${workspace.label}" workspace?`,
      message: "Its folder stays on disk.",
      confirmLabel: "Delete workspace",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
      await loadWorkspaces();
      toast(`Deleted ${workspace.label}`);
    } catch (error) {
      toast.error(error.message);
    }
  }, " danger"));
  const { actions, more } = rowActions(buttons, `Actions for ${workspace.label}`);
  more.dataset.testid = "workspace-more";
  row.append(main, folder, actions, more);
  return row;
}

async function addWorkspace() {
  const label = elements.workspaceNameInput.value.trim();
  if (!label) return;
  if (elements.workspaceAddButton.disabled) return;
  elements.workspaceAddButton.disabled = true;
  let created;
  try {
    created = await api("/api/workspaces", { method: "PUT", body: JSON.stringify({ label, sharing: workspaceCreationSharing() }) });
  } finally { elements.workspaceAddButton.disabled = false; }
  elements.workspaceNameInput.value = "";
  resetWorkspaceCreationSharing();
  // The new workspace's page shows, wherever the list was.
  revealWorkspaceId = created?.workspace?.id ?? null;
  await loadWorkspaces();
  toast(`Added ${label}`);
}

export function openProjectPathMapping(project) {
  state.mappingProjectId = project.id;
  elements.projectPathTitle.textContent = `${project.name} session paths`;
  elements.projectHomeserverPathInput.value = project.path;
  elements.projectMacPathInput.value = project.macPath || "";
  elements.projectPathDialog.showModal();
}
elements.projectWorkspaceInput.addEventListener("change", () => fillProjectBases().catch((error) => toast.error(error.message)));
installWorkspaceCreationSharing(elements.workspaceAddButton);
elements.workspaceAddButton.addEventListener("click", () => addWorkspace().catch((error) => toast.error(error.message)));
elements.workspaceNameInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addWorkspace().catch((error) => toast.error(error.message));
});
