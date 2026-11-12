import { z } from "zod";

export const taskDomainSchema = z.enum(["software-repair", "terminal", "planning", "ui", "security", "other"]);
export const modelIdentitySchema = z.object({
  provider: z.string().min(1).max(200), modelId: z.string().min(1).max(300), release: z.string().min(1).max(200),
  harness: z.string().min(1).max(80), scaffold: z.string().min(1).max(200), reasoning: z.string().min(1).max(80),
}).strict();
export type ModelIdentity = z.infer<typeof modelIdentitySchema>;
export function modelKey(model: ModelIdentity): string {
  return JSON.stringify([model.provider, model.modelId, model.release, model.harness, model.scaffold, model.reasoning]);
}

/** Only versioned, comparable percentage-resolved records; display names are not model identities. */
export const evidenceSchema = z.object({
  sourceUrl: z.string().url().refine(value => new URL(value).protocol === "https:"),
  retrievedAt: z.string().datetime(), publishedAt: z.string().datetime(),
  benchmark: z.literal("swe-bench-verified"), version: z.literal("500"), domain: z.literal("software-repair"),
  identity: modelIdentitySchema, score: z.number().finite().min(0).max(100), unit: z.literal("percent-resolved"),
  sampleSize: z.literal(500), limitations: z.array(z.string().min(1).max(2000)).min(1).max(20),
}).strict().refine(value => Date.parse(value.publishedAt) <= Date.parse(value.retrievedAt), "Publication cannot follow retrieval");
export type ModelEvidence = z.infer<typeof evidenceSchema>;
export const EVIDENCE_MAX_AGE_DAYS = 90;
export function evidenceFresh(evidence: ModelEvidence, now: string): boolean {
  const age = Date.parse(now) - Date.parse(evidence.retrievedAt);
  const publicationAge = Date.parse(now) - Date.parse(evidence.publishedAt);
  return age >= 0 && age <= EVIDENCE_MAX_AGE_DAYS * 86_400_000 && publicationAge >= 0 && publicationAge <= EVIDENCE_MAX_AGE_DAYS * 86_400_000;
}

export const assessmentSchema = z.object({
  taskId: z.string().min(1).max(200), domain: taskDomainSchema, complexity: z.number().int().min(1).max(10),
  risk: z.enum(["low", "medium", "high"]), capabilities: z.array(z.string().min(1).max(80)).max(30),
  classifier: z.string().min(1).max(200), confidence: z.number().finite().min(0).max(1),
}).strict();
export type TaskAssessment = z.infer<typeof assessmentSchema>;

export const outcomeSchema = z.object({
  taskId: z.string().min(1).max(200), projectId: z.string().min(1).max(200), attemptId: z.string().min(1).max(200),
  identity: modelIdentitySchema, domain: taskDomainSchema, complexity: z.number().int().min(1).max(10), risk: z.enum(["low", "medium", "high"]),
  outcome: z.enum(["verified", "failed", "auth-error", "unavailable", "unknown"]),
  cost: z.number().finite().nonnegative().nullable(), latencyMs: z.number().finite().nonnegative().nullable(), occurredAt: z.string().datetime(),
}).strict();
export type ModelOutcome = z.infer<typeof outcomeSchema>;
