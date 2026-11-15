import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { addSharingMember, createSharingCluster, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import { agentPolicyBodySchema, setClusterAgentPolicy } from "../src/cluster-agent-policy.js";
import { assertClusterResourcesPresent, clusterPolicySkillPaths, prepareClusterPolicySkills } from "../src/cluster-agent-resources.js";
import { agentResourcePaths } from "../src/agent-resources.js";
import { activeSkillRoot, activationDecision, setActivationPreference } from "../src/resource-activation.js";
import { buildSkillBundle } from "../src/skill-sharing.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { DEFAULT_GUARDIAN_SETTINGS } from "../src/guardian/rules.js";
import { guardianGroups, updateGuardianSettings } from "../src/guardian/settings.js";
import { summaryPolicyNow } from "../src/server/conversation-digest-runner.js";

async function cluster() {
  const db = await clusterV2Database(), manager = (await getClusterNode()).id, clusterId = randomUUID(), projectId = randomUUID();
  createSharingCluster(db, { id: clusterId, name: "Scoped resource policy" }, manager);
  registerOwnedResource(db, { kind: "project", id: projectId, ownerNodeId: manager }, manager);
  setResourceShares(db, manager, "project", projectId, [{ clusterId, projectId: null }]);
  return { db, manager, clusterId, projectId };
}

test("required skills use verified private copies, not a same-named installed skill", async () => {
  const { db, manager, clusterId, projectId } = await cluster();
  const name = `policy-${randomUUID()}`, source = path.join(agentResourcePaths().sharedSkills, name);
  const previousIsolation = getSettings().strictResourceIsolation;
  updateSettings({ strictResourceIsolation: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), `---\nname: ${name}\ndescription: Test policy\n---\nVerified content\n`);
  let privateRoot: string | undefined;
  try {
    const { digest } = await buildSkillBundle(source, name);
    const policy = agentPolicyBodySchema.parse({ enabled: { skills: { pi: [name], claude: [], kiro: [] }, mcp: { pi: [], claude: [], kiro: [] }, plugins: { pi: [], claude: [], kiro: [] } }, skillDigests: { [name]: digest } });
    policy.settings.skills.enforce = true;
    setClusterAgentPolicy(db, manager, clusterId, { policy, sourceRelayNodeId: null }, 1);
    assert.throws(() => clusterPolicySkillPaths(projectId, "pi"), /unavailable/);
    await prepareClusterPolicySkills(projectId, "pi");
    [privateRoot] = clusterPolicySkillPaths(projectId, "pi");
    assert.notEqual(privateRoot, source);
    setActivationPreference("skill", name, "pi", false);
    assert.equal(activeSkillRoot("pi", privateRoot, { projectId }), privateRoot);
    assert.equal(activationDecision("skill", name, "pi", false, false, projectId).enabled, false, "native copies cannot substitute");
    assert.notEqual(activeSkillRoot("pi", source, { projectId }), source);
    await writeFile(path.join(privateRoot, "SKILL.md"), `---\nname: ${name}\ndescription: Tampered\n---\nChanged\n`);
    await assert.rejects(prepareClusterPolicySkills(projectId, "pi"), /signed digest/);
    policy.settings.mcp.enforce = true; policy.enabled.mcp.pi = ["missing-server"];
    setClusterAgentPolicy(db, manager, clusterId, { policy, sourceRelayNodeId: null }, 1);
    assert.throws(() => assertClusterResourcesPresent(projectId, "pi", "mcp", []), /unavailable.*missing-server/);
    assert.doesNotThrow(() => assertClusterResourcesPresent("unrelated", "pi", "mcp", []));
  } finally {
    updateSettings({ strictResourceIsolation: previousIsolation });
    setActivationPreference("skill", name, "pi", null);
    await rm(source, { recursive: true, force: true });
    if (privateRoot) await rm(path.dirname(privateRoot), { recursive: true, force: true });
  }
});

test("Guardian and summary policy stay scoped even with local Guardian disabled", async () => {
  const { db, manager, clusterId, projectId } = await cluster();
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: false });
  const policy = agentPolicyBodySchema.parse({ guardian: { model: "jev", layaUrl: "", rules: [{ ...DEFAULT_GUARDIAN_SETTINGS.rules[0], enabled: true }] }, summary: { updates: "manual", writer: { source: "conversation" } } });
  setClusterAgentPolicy(db, manager, clusterId, { policy, sourceRelayNodeId: null }, 1);
  assert.equal((await guardianGroups(projectId)).length, 1);
  assert.deepEqual(await guardianGroups("unrelated"), []);
  assert.equal((await summaryPolicyNow(projectId)).updates, "manual");
  assert.equal((await summaryPolicyNow("unrelated")).from.kind, "node");
});
