import { clusterV2Database } from "../cluster-v2-store.js";
import { allClusterAgentPolicies, projectAgentPolicies } from "../cluster-agent-policy.js";
import { save, settingsDatabase, value } from "../settings-store.js";
import { actsOnProduction, productionGuardStatus, type ProductionGuardStatus } from "./production-rule.js";
import { DEFAULT_GUARDIAN_SETTINGS, guardianSettingsSchema, type GuardianModelId, type GuardianRule, type GuardianSettings } from "./rules.js";

const SETTINGS_KEY = "guardian";

export function getGuardianSettings(): GuardianSettings {
  const stored = value(SETTINGS_KEY);
  if (!stored) return structuredClone(DEFAULT_GUARDIAN_SETTINGS);
  const settings = guardianSettingsSchema.parse(JSON.parse(stored));
  // Upgrade only the shipped question; preserve questions the person customized.
  for (const rule of settings.rules) {
    if (rule.id === 'dangerous-commands' && rule.question === 'Could this action delete data, or make a change to the system that cannot be undone?') {
      rule.question = DEFAULT_GUARDIAN_SETTINGS.rules[0].question;
    }
  }
  return settings;
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

export interface ProductionGuardCoverage {
  status: ProductionGuardStatus;
  /** The clusters or relays whose rule asks first, for the projects they cover. */
  coveredBy: string[];
  /** Projects nothing asks first in: this machine's Guardian is not on and no relay or cluster imposes the rule on them. */
  uncovered: string[];
}

/**
 * Where production and destructive steps ask first, project by project. This machine's own Guardian covers every
 * project; without it, a project is covered only by a rule that a cluster or relay it is shared with imposes.
 */
export async function productionGuardCoverage(projects: Array<{ id: string; name: string }>): Promise<ProductionGuardCoverage> {
  const own = productionGuardStatus(getGuardianSettings());
  if (own === "on") return { status: "on", coveredBy: [], uncovered: [] };
  if (!projects.length) return { status: await productionGuard(), coveredBy: [], uncovered: [] };
  const db = await clusterV2Database();
  const coveredBy = new Set<string>(), uncovered: string[] = [];
  for (const project of projects) {
    const imposing = projectAgentPolicies(db, project.id).filter((layer) => layer.policy.guardian?.rules.some(actsOnProduction));
    if (imposing.length) imposing.forEach((layer) => coveredBy.add(layer.source));
    else uncovered.push(project.name);
  }
  return { status: uncovered.length ? own : "on", coveredBy: [...coveredBy], uncovered };
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
