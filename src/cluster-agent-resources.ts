import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { settingsDatabase } from "./settings-store.js";
import { projectAgentPolicies } from "./cluster-agent-policy.js";
import { getClusterNode } from "./cluster.js";
import { resolveDataDirectory } from "./data-directory.js";
import { buildSkillBundle, installSkillBundle, skillBundleDigest, skillDigest } from "./skill-sharing.js";
import { agentResourcePaths } from "./agent-resources.js";
import { getSettings } from "./settings.js";
import type { HarnessId } from "./types.js";

function requiredSkills(projectId: string | undefined, harness: HarnessId) {
  return projectAgentPolicies(settingsDatabase(), projectId).flatMap(layer => {
    if (!layer.policy.settings.skills.enforce) return [];
    return ((layer.policy.enabled.skills as Record<string, string[]>)[harness] ?? []).map(name => {
      const digest = layer.policy.skillDigests?.[name];
      if (!digest) throw new Error(`Cluster ${layer.source} requires skill ${name} without a signed content digest`);
      return { ...layer, name, digest, root: path.join(resolveDataDirectory(), "runtime", "cluster-skills", layer.sourceNodeId, digest, name) };
    });
  });
}
/** Private digest-addressed copies cannot replace another project's installed skill. */
export function clusterPolicySkillPaths(projectId: string | undefined, harness: HarnessId): string[] {
  return requiredSkills(projectId, harness).map(item => {
    if (!existsSync(item.root)) throw new Error(`Required cluster skill ${item.name} is unavailable; prepare this project's policy resources before launch`);
    return item.root;
  });
}
export function assertClusterResourcesPresent(projectId: string | undefined, harness: HarnessId, kind: "mcp" | "plugins", names: string[]): void {
  for (const layer of projectAgentPolicies(settingsDatabase(), projectId)) {
    if (!layer.policy.settings[kind].enforce) continue;
    for (const name of (layer.policy.enabled[kind] as Record<string, string[]>)[harness] ?? []) {
      if (!names.includes(name)) throw new Error(`Cluster ${layer.source} requires unavailable ${kind} resource ${name} for ${harness}`);
    }
  }
}
export function assertClusterResourceSupport(projectId: string | undefined, harness: HarnessId): void {
  const restricted = projectAgentPolicies(settingsDatabase(), projectId).some(layer => layer.policy.rules.length || Object.values(layer.policy.settings).some(toggle => toggle.enforce || !toggle.allowOthers));
  if (!restricted) return;
  if (harness === "antigravity") throw new Error("Antigravity cannot enforce this cluster's agent resource policy; choose another harness");
  if (!getSettings().strictResourceIsolation) throw new Error("Cluster agent resource policy requires strict resource isolation on this machine");
}
export async function prepareClusterPolicySkills(projectId: string | undefined, harness: HarnessId): Promise<void> {
  assertClusterResourceSupport(projectId, harness);
  const local = await getClusterNode(), db = settingsDatabase();
  for (const item of requiredSkills(projectId, harness)) {
    if (!existsSync(item.root)) {
      let bundle: unknown;
      if (item.sourceNodeId === local.id) bundle = (await buildSkillBundle(path.join(agentResourcePaths().sharedSkills, item.name), item.name)).bundle;
      else {
        const { signedPost } = await import("./server/cluster-v2.js");
        bundle = (await signedPost<{ bundle: unknown }>(db, local.id, item.sourceNodeId, item.clusterId, "/api/cluster/v2/agent-policy/skill", { clusterId: item.clusterId, name: item.name, digest: item.digest })).bundle;
      }
      if (skillBundleDigest(bundle) !== item.digest) throw new Error(`Cluster skill ${item.name} does not match its signed digest`);
      await mkdir(path.dirname(item.root), { recursive: true });
      await installSkillBundle(bundle, item.name, item.root, path.join(resolveDataDirectory(), "runtime", "cluster-skill-staging"));
    }
    if (await skillDigest(item.root, item.name) !== item.digest) throw new Error(`Cluster skill ${item.name} no longer matches its signed digest`);
  }
}
