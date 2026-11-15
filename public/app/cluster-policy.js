import { api } from "./api.js";

function element(tag, text, testid) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (testid) node.dataset.testid = testid;
  return node;
}
function field(section, label, control) {
  const wrapper = element("label", label); wrapper.append(control); section.append(wrapper); return control;
}
function button(label, testid) {
  const node = element("button", label, testid); node.type = "button"; node.className = "primary compact"; return node;
}
export function installPolicyTab(tabs, pane) {
  const tab = button("Policy & pools", "cluster-tab-policy");
  tab.className = "settings-subtab"; tab.dataset.clusterTab = "policy"; tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", "clusterPolicy"); tabs.append(tab);
  const section = element("section", undefined, "cluster-policy"); section.id = "clusterPolicy"; section.dataset.clusterPanel = "policy"; section.className = "cluster-tab-panel"; section.hidden = true; section.setAttribute("role", "tabpanel"); pane.append(section);
}

export async function renderClusterPolicy(cluster, localNodeId, nodeName) {
  const section = document.getElementById("clusterPolicy");
  // Directory refreshes must not erase a draft or a save result.
  if (section.dataset.clusterId === cluster.id && section.dataset.epoch === String(cluster.managerEpoch)) return;
  section.dataset.clusterId = cluster.id;
  section.dataset.epoch = String(cluster.managerEpoch);
  section.replaceChildren(element("p", "Loading policy…"));
  const manager = cluster.managerNodeId === localNodeId;
  try {
    const base = `/api/clusters/${cluster.id}`;
    const [view, assigned, grants, offered] = await Promise.all([
      api(`${base}/agent-policy`), api(`${base}/subscription-pool`), api(`${base}/pool-grants`),
      manager ? api(`${base}/available-pools`) : Promise.resolve({ pools: [] }),
    ]);
    if (section.dataset.clusterId !== cluster.id) return;
    section.replaceChildren(element("p", "These restrictions apply to projects shared through this cluster, regardless of the relay carrying traffic.", "cluster-policy-intro"));
    const source = field(section, "Inherit signed policy from", element("select", undefined, "cluster-policy-source"));
    const none = element("option", "No inherited source"); none.value = ""; source.append(none);
    for (const item of view.sources) { const option = element("option", nodeName(item.nodeId)); option.value = item.nodeId; source.append(option); }
    source.value = view.policy?.sourceRelayNodeId ?? ""; source.disabled = !manager;
    const original = view.policy?.policy ?? view.effective.local;
    const blocked = field(section, "Blocked skills (one name per line, all agents)", element("textarea", undefined, "cluster-policy-blocked-skills"));
    blocked.rows = 4; blocked.value = original.rules.filter(rule => rule.action === "block" && rule.harness === "all").map(rule => rule.name).join("\n"); blocked.disabled = !manager;
    const advanced = element("details"); advanced.append(element("summary", "Advanced policy")); section.append(advanced);
    const json = field(advanced, "Resource settings, enabled resources, Guardian and summary policy (JSON)", element("textarea", undefined, "cluster-policy-json"));
    json.rows = 12; json.value = JSON.stringify(original, null, 2); json.disabled = !manager; json.spellcheck = false;
    if (view.effective.source) { const inherited = element("pre", JSON.stringify(view.effective.source, null, 2)); inherited.style.whiteSpace = "pre-wrap"; section.append(element("h4", "Inherited restrictions (cannot be weakened)"), inherited); }
    const status = element("p", "", "cluster-policy-status"); status.setAttribute("role", "status");
    const save = button("Save policy", "cluster-policy-save"); save.disabled = !manager;
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const policy = JSON.parse(json.value);
        const names = [...new Set(blocked.value.split(/\s+/).filter(Boolean))];
        policy.rules = [...policy.rules.filter(rule => !(rule.action === "block" && rule.harness === "all")), ...names.map(name => ({ action: "block", name, harness: "all" }))];
        const result = await api(`${base}/agent-policy`, { method: "PUT", body: JSON.stringify({ expectedEpoch: cluster.managerEpoch, sourceRelayNodeId: source.value || null, policy }) });
        json.value = JSON.stringify(result.policy.policy, null, 2); status.textContent = "Policy saved";
      } catch (error) { status.textContent = error.message; }
      finally { save.disabled = !manager; }
    });
    section.append(save, status, element("h4", "Mandatory subscription pool"), element("p", "Cluster pools override personal, machine, project, conversation and pinned automation choices. Multiple applicable pools use stable cluster order; failover stays within the chosen pool."));
    const pool = field(section, "Assigned pool", element("select", undefined, "cluster-policy-pool")); pool.disabled = !manager;
    const noPool = element("option", "No mandatory pool"); noPool.value = ""; pool.append(noPool);
    const pools = [...offered.pools];
    if (assigned.assignment && !pools.some(item => item.poolId === assigned.assignment.poolId && item.poolOwnerNodeId === assigned.assignment.poolOwnerNodeId)) pools.push({ ...assigned.assignment, name: assigned.assignment.manifest.name });
    for (const item of pools) { const option = element("option", `${item.name} · ${nodeName(item.poolOwnerNodeId)}`); option.value = JSON.stringify([item.poolOwnerNodeId, item.poolId]); pool.append(option); }
    if (assigned.assignment) pool.value = JSON.stringify([assigned.assignment.poolOwnerNodeId, assigned.assignment.poolId]);
    let active = assigned.assignment;
    const poolSave = button("Save pool", "cluster-policy-pool-save"); poolSave.disabled = !manager;
    const poolStatus = element("p", "", "cluster-policy-pool-status"); poolStatus.setAttribute("role", "status");
    poolSave.addEventListener("click", async () => {
      poolSave.disabled = true;
      try {
        if (active && (!pool.value || pool.value !== JSON.stringify([active.poolOwnerNodeId, active.poolId]))) {
          await api(`${base}/subscription-pool`, { method: "DELETE", body: JSON.stringify({ expectedEpoch: cluster.managerEpoch, poolId: active.poolId, poolOwnerNodeId: active.poolOwnerNodeId }) }); active = null;
        }
        if (pool.value) { const [poolOwnerNodeId, poolId] = JSON.parse(pool.value); active = (await api(`${base}/subscription-pool`, { method: "POST", body: JSON.stringify({ expectedEpoch: cluster.managerEpoch, poolOwnerNodeId, poolId }) })).assignment; }
        poolStatus.textContent = "Pool saved";
      } catch (error) { poolStatus.textContent = error.message; }
      finally { poolSave.disabled = !manager; }
    });
    section.append(poolSave, poolStatus, element("h4", "Pools hosted here"), element("p", "Grant this cluster permission to use one of your pools. Credentials stay on this machine. Revoking access stops future provider requests; it does not remove the cluster's mandatory assignment."));
    for (const own of grants.pools) {
      const control = element("input", undefined, `cluster-pool-grant-${own.poolId}`); control.type = "checkbox"; control.checked = own.enabled;
      const feedback = element("span"); feedback.setAttribute("role", "status");
      field(section, own.name, control).parentElement.append(feedback);
      control.addEventListener("change", async () => { control.disabled = true; try { await api(`/api/provider-profiles/pools/${own.poolId}/cluster-grants/${cluster.id}`, { method: "PUT", body: JSON.stringify({ enabled: control.checked }) }); feedback.textContent = "Saved"; } catch (error) { control.checked = !control.checked; feedback.textContent = error.message; } finally { control.disabled = false; } });
    }
    if (!manager) section.append(element("p", "The cluster manager edits its policy and mandatory pool. You can grant or revoke pools you host."));
  } catch (error) { if (section.dataset.clusterId === cluster.id) { delete section.dataset.epoch; section.replaceChildren(element("p", error.message)); } }
}
