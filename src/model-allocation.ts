import { z } from "zod";
import { assessmentSchema, evidenceSchema, evidenceFresh, modelIdentitySchema, modelKey, outcomeSchema, type ModelIdentity, type ModelOutcome } from "./model-evidence.js";

export const ALLOCATION_POLICY_VERSION = "1";
const minimumSamples = 20;
const qualityFloors = { low: 0.6, medium: 0.75, high: 0.9 };
const money = z.number().finite().nonnegative();
export const candidateSchema = z.object({
  identity: modelIdentitySchema, authorized: z.boolean(), available: z.boolean(), capabilities: z.array(z.string().min(1)).max(30),
  attemptCost: money.nullable(), handoffCost: money.nullable(), evaluationCost: money.nullable(), recoveryCost: money.nullable(),
}).strict();
export const allocationInputSchema = z.object({
  assessment: assessmentSchema, baseline: modelIdentitySchema, pinned: z.boolean(), candidates: z.array(candidateSchema).max(200),
  evidence: z.array(evidenceSchema).max(2000), outcomes: z.array(outcomeSchema).max(20_000),
  authorizedProjectIds: z.array(z.string().min(1)).max(2000), now: z.string().datetime(),
}).strict();
export type AllocationInput = z.infer<typeof allocationInputSchema>;
export interface RankedModel { identity: ModelIdentity; samples: number; successEstimate: number; lowerBound: number; expectedCost: number; benchmarkAgeDays: number | null; uncertainty: string }

function lowerBound(successes: number, total: number): number {
  const z = 1.96, p = successes / total;
  return (p + z * z / (2 * total) - z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))) / (1 + z * z / total);
}

/** Pure recommendation. It cannot change a provider, authorize credentials, or execute an attempt. */
export function recommendModels(raw: AllocationInput) {
  const input = allocationInputSchema.parse(raw);
  const ranked: RankedModel[] = [], excluded: Array<{ identity: ModelIdentity; reason: string }> = [];
  if (input.pinned || input.assessment.confidence < 0.8 || input.assessment.domain === "other") return { mode: "recommendation-only" as const, version: ALLOCATION_POLICY_VERSION, baseline: input.baseline, recommended: null, ranked, excluded, reason: input.pinned ? "Manual selection wins" : "Assessment is uncertain or unsupported; retain baseline" };
  for (const candidate of input.candidates) {
    const exclude = (reason: string) => excluded.push({ identity: candidate.identity, reason });
    if (!candidate.authorized || !candidate.available) { exclude("Account or harness is not available and authorized"); continue; }
    if (input.assessment.capabilities.some(capability => !candidate.capabilities.includes(capability))) { exclude("Required capability unavailable"); continue; }
    if ([candidate.attemptCost, candidate.handoffCost, candidate.evaluationCost, candidate.recoveryCost].some(cost => cost === null)) { exclude("Unknown price; never treated as zero"); continue; }
    const key = modelKey(candidate.identity);
    const matching = input.outcomes.filter(row => input.authorizedProjectIds.includes(row.projectId) && modelKey(row.identity) === key && row.domain === input.assessment.domain && row.risk === input.assessment.risk && row.complexity === input.assessment.complexity && Date.parse(row.occurredAt) <= Date.parse(input.now));
    // Repeated attempts on the same task are not independent success samples.
    const tasks = new Map<string, ModelOutcome>();
    for (const row of [...matching].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) tasks.set(`${row.projectId}\0${row.taskId}`, row);
    const known = [...tasks.values()].filter(row => row.outcome === "verified" || row.outcome === "failed");
    if (known.length < minimumSamples) { exclude(`Insufficient comparable verified history (${known.length}/${minimumSamples}); benchmarks alone do not establish task success`); continue; }
    const benchmark = input.evidence.filter(row => modelKey(row.identity) === key && row.domain === input.assessment.domain && evidenceFresh(row, input.now)).sort((a, b) => b.retrievedAt.localeCompare(a.retrievedAt))[0];
    const successes = known.filter(row => row.outcome === "verified").length;
    const priorWeight = benchmark ? 10 : 2;
    const prior = benchmark ? benchmark.score / 100 : 0.5;
    const estimate = (successes + priorWeight * prior) / (known.length + priorWeight);
    // A benchmark may shrink the estimate, but cannot raise the empirical safety floor.
    const lower = Math.min(lowerBound(successes, known.length), lowerBound(successes + priorWeight * prior, known.length + priorWeight));
    if (lower < qualityFloors[input.assessment.risk]) { exclude("Evidence falls below the risk quality floor"); continue; }
    const total = candidate.attemptCost! + candidate.handoffCost! + candidate.evaluationCost! + (1 - estimate) * candidate.recoveryCost!;
    ranked.push({ identity: candidate.identity, samples: known.length, successEstimate: estimate, lowerBound: lower, expectedCost: total / estimate,
      benchmarkAgeDays: benchmark ? (Date.parse(input.now) - Date.parse(benchmark.publishedAt)) / 86_400_000 : null,
      uncertainty: "Observational group evidence, not a per-task guarantee; costs depend on the supplied token/cache and recovery estimates" });
  }
  ranked.sort((a, b) => a.expectedCost - b.expectedCost || modelKey(a.identity).localeCompare(modelKey(b.identity)));
  return { mode: "recommendation-only" as const, version: ALLOCATION_POLICY_VERSION, baseline: input.baseline, recommended: ranked[0]?.identity ?? null, ranked, excluded,
    reason: ranked.length ? "Lowest estimated total cost among candidates meeting the quality floor" : "No qualified candidate; retain the approved baseline" };
}

export const recoveryStateSchema = z.object({ attempts: z.number().int().min(0).max(2), spent: money, reserved: money, allowance: money, pendingExternalOperation: z.boolean(), writerActive: z.boolean(), validated: z.boolean(), enabled: z.boolean() }).strict();
export type RecoveryState = z.infer<typeof recoveryStateSchema>;
export function reserveRecovery(raw: RecoveryState, cost: number, nextQuality: number, previousQuality: number): RecoveryState {
  const state = recoveryStateSchema.parse(raw);
  money.parse(cost);
  z.number().min(0).max(1).parse(nextQuality); z.number().min(0).max(1).parse(previousQuality);
  if (!state.enabled || !state.validated) throw new Error("Automatic recovery requires explicit opt-in and held-out validation");
  if (state.writerActive || state.pendingExternalOperation) throw new Error("Recovery must wait for the writer and uncertain external operations");
  if (state.attempts >= 2 || nextQuality <= previousQuality) throw new Error("Ask the user: no stronger permitted recovery attempt remains");
  if (state.allowance <= 0 || state.spent + state.reserved + cost > state.allowance) throw new Error("Ask the user: approved recovery allowance is exhausted");
  return { ...state, attempts: state.attempts + 1, reserved: state.reserved + cost };
}

/** Historical reports never imply that changing the policy caused the observed outcome. */
export function evaluateHeldOut(raw: ModelOutcome[], trainingTaskIds: string[]) {
  const rows = z.array(outcomeSchema).parse(raw).filter(row => !trainingTaskIds.includes(row.taskId));
  const tasks = new Map<string, ModelOutcome>();
  for (const row of [...rows].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) tasks.set(`${row.projectId}\0${row.taskId}`, row);
  const final = [...tasks.values()];
  return { observational: true, tasks: final.length, verified: final.filter(row => row.outcome === "verified").length,
    unknown: final.filter(row => !["verified", "failed"].includes(row.outcome)).length,
    totalCost: rows.some(row => row.cost === null) ? null : rows.reduce((sum, row) => sum + row.cost!, 0),
    latencyMs: rows.some(row => row.latencyMs === null) ? null : rows.reduce((sum, row) => sum + row.latencyMs!, 0),
    escalationRate: final.length ? (rows.length - final.length) / final.length : null };
}
