import { clusterV2Database } from "../cluster-v2-store.js";
import { allClusterAgentPolicies, projectAgentPolicies } from "../cluster-agent-policy.js";
import { save, settingsDatabase, value } from "../settings-store.js";
import { actsOnProduction, productionGuardStatus, type ProductionGuardStatus } from "./production-rule.js";
import { DEFAULT_GUARDIAN_SETTINGS, guardianSettingsSchema, type GuardianModelId, type GuardianRule, type GuardianSettings } from "./rules.js";

const SETTINGS_KEY = "guardian";

export function getGuardianSettings(): GuardianSettings {
  const stored = value(SETTINGS_KEY);
  if (!stored) return structuredClone(DEFAULT_GUARDIAN_SETTINGS);
  return guardianSettingsSchema.parse(JSON.parse(stored));
}

export function updateGuardianSettings(input: unknown): GuardianSettings {
  const settings = guardianSettingsSchema.parse(input);
  save(settingsDatabase(), SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

/** Rules that share one author and one model: this machine's own, or one relay's. */
export interface GuardianGroup {
  /** "This machine", or the relay's label. */
  source: string;
  relay: boolean;
  model: GuardianModelId;
  layaUrl: string;
  rules: GuardianRule[];
  /** For a relay's rules: the relay that imposes them. */
  relayNodeId?: string;
}

/** Every rule that applies on this machine: its own while Guardian is on, and every admitted relay's, always. */
export async function guardianGroups(projectId?: string): Promise<GuardianGroup[]> {
  const local = getGuardianSettings();
  const groups: GuardianGroup[] = local.enabled ? [{ source: "This machine", relay: false, model: local.model, layaUrl: local.layaUrl, rules: local.rules }] : [];
  for (const layer of projectAgentPolicies(await clusterV2Database(), projectId)) {
    const policy = layer.policy.guardian;
    if (policy) groups.push({ source: layer.source, relay: true, model: policy.model, layaUrl: policy.layaUrl, rules: policy.rules, relayNodeId: layer.sourceNodeId });
  }
  return groups;
}

/**
 * Whether production and destructive steps ask first: through this machine's own Guardian, or through a rule
 * its clusters impose. With a project, the policies of that project's clusters count; without one, the
 * machine is covered only when every cluster it has a policy for imposes the rule.
 */
export async function productionGuard(projectId?: string): Promise<ProductionGuardStatus> {
  const own = productionGuardStatus(getGuardianSettings());
  if (own === "on") return "on";
  const db = await clusterV2Database();
  const clusters = projectId ? [projectAgentPolicies(db, projectId)] : allClusterAgentPolicies(db);
  const imposed = (layers: ReturnType<typeof projectAgentPolicies>) => layers.some((layer) => layer.policy.guardian?.rules.some(actsOnProduction));
  return clusters.length > 0 && clusters.every(imposed) ? "on" : own;
}
