import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { allocationAttemptSchema, allocationPolicySchema, allocationValidation, type AllocationAttempt, type AllocationPolicy } from "./model-allocation-policy.js";
import { assessmentSchema, modelIdentitySchema, modelKey, outcomeSchema, type ModelOutcome } from "./model-evidence.js";
import { recoveryStateSchema, reserveRecovery, type RecoveryState } from "./model-allocation.js";

const recoveryExecutionSchema = z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(200), originAttemptId: z.string().min(1).max(200), identity: modelIdentitySchema, assessment: assessmentSchema }).strict();
const reservationSchema = z.object({
  execution: recoveryExecutionSchema.optional(),
  harness: z.string().trim().min(1).max(80),
  taskId: z.string().min(1).max(200), operationId: z.string().min(1).max(200), cost: z.number().finite().nonnegative(),
  nextQuality: z.number().min(0).max(1), previousQuality: z.number().min(0).max(1),
  checkpoint: z.object({ worktreeId: z.string().min(1).max(200), baseCommit: z.string().regex(/^[a-f0-9]{40}$/), candidateCommit: z.string().regex(/^[a-f0-9]{40}$/), checkIds: z.array(z.string().min(1).max(200)).max(100) }).strict(),
}).strict();

/** Machine-local derived evidence only. No transcript, prompt, credential or command columns. */
export class AllocationStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS model_allocation_outcomes(owner_id TEXT NOT NULL,project_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner_id,project_id,attempt_id));
      CREATE TABLE IF NOT EXISTS model_allocation_tasks(owner_id TEXT NOT NULL,task_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner_id,task_id));
      CREATE TABLE IF NOT EXISTS model_allocation_reservations(operation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,request_hash TEXT NOT NULL,checkpoint TEXT NOT NULL,result TEXT NOT NULL,finished INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS model_allocation_dispatches(operation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_allocation_policies(owner_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_allocation_attempts(owner_id TEXT NOT NULL,project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,check_status TEXT,check_id TEXT,attributed INTEGER,PRIMARY KEY(owner_id,project_id,attempt_id));`);
  }

  policy(ownerId: string): AllocationPolicy {
    const row = this.db.prepare("SELECT payload FROM model_allocation_policies WHERE owner_id=?").get(ownerId) as { payload: string } | undefined;
    return row ? allocationPolicySchema.parse(JSON.parse(row.payload)) : { mode: "off", candidates: [], evidence: [], recoveryAllowance: 0, acceptedValidation: false };
  }

  savePolicy(ownerId: string, raw: unknown, projectIds: string[] = []): void {
    const policy = allocationPolicySchema.parse(raw);
    if (policy.mode === "automatic" && (!policy.acceptedValidation || !allocationValidation(policy, this.outcomes(ownerId, projectIds)).passed)) throw new Error("Automatic allocation requires accepted held-out validation");
    this.db.prepare("INSERT INTO model_allocation_policies VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET payload=excluded.payload").run(ownerId, JSON.stringify(policy));
  }

  beginAttempt(ownerId: string, raw: unknown): boolean {
    const input = allocationAttemptSchema.parse(raw);
    if (this.policy(ownerId).mode === "off") return false;
    const result = this.db.prepare("INSERT INTO model_allocation_attempts(owner_id,project_id,conversation_id,attempt_id,payload) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING")
      .run(ownerId, input.projectId, input.conversationId, input.attemptId, JSON.stringify(input));
    if (!result.changes) throw new Error("Allocation attempt already exists; reconcile before repeating execution");
    return true;
  }

  latestAttempt(ownerId: string, projectId: string, conversationId: string): AllocationAttempt | null {
    const row = this.db.prepare("SELECT payload FROM model_allocation_attempts WHERE owner_id=? AND project_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 1").get(ownerId, projectId, conversationId) as { payload: string } | undefined;
    return row ? allocationAttemptSchema.parse(JSON.parse(row.payload)) : null;
  }

  verifyAttempt(ownerId: string, projectId: string, conversationId: string, checkId: string, status: "committed" | "verification-failed" | "conflict", attemptId: string): boolean {
    if (this.policy(ownerId).mode === "off" || status === "conflict") return false;
    const outcome = status === "committed" ? "verified" : "failed";
    const result = this.db.prepare("UPDATE model_allocation_attempts SET check_status=?,check_id=? WHERE owner_id=? AND project_id=? AND conversation_id=? AND attempt_id=?")
      .run(outcome, checkId, ownerId, projectId, conversationId, attemptId);
    const existing = this.db.prepare("SELECT payload FROM model_allocation_outcomes WHERE owner_id=? AND project_id=? AND attempt_id=?").get(ownerId, projectId, attemptId) as { payload: string } | undefined;
    const attribution = this.db.prepare("SELECT attributed,payload FROM model_allocation_attempts WHERE owner_id=? AND project_id=? AND attempt_id=?").get(ownerId, projectId, attemptId) as { attributed: number | null; payload: string } | undefined;
    if (result.changes && existing && attribution?.attributed === 1 && allocationAttemptSchema.parse(JSON.parse(attribution.payload)).assessment.confidence >= 0.8) this.recordOutcome(ownerId, { ...outcomeSchema.parse(JSON.parse(existing.payload)), outcome }, true);
    return Boolean(result.changes);
  }

  finishAttempt(ownerId: string, projectId: string, attemptId: string, raw: { cost: number | null; latencyMs: number | null; failed: boolean; attributed: boolean }): void {
    const completed = z.object({ cost: z.number().finite().nonnegative().nullable(), latencyMs: z.number().finite().nonnegative().nullable(), failed: z.boolean(), attributed: z.boolean() }).strict().parse(raw);
    if (this.policy(ownerId).mode === "off") return;
    const row = this.db.prepare("SELECT payload,check_status FROM model_allocation_attempts WHERE owner_id=? AND project_id=? AND attempt_id=?").get(ownerId, projectId, attemptId) as { payload: string; check_status: string | null };
    const input = allocationAttemptSchema.parse(JSON.parse(row.payload));
    this.db.prepare("UPDATE model_allocation_attempts SET attributed=? WHERE owner_id=? AND project_id=? AND attempt_id=?").run(Number(completed.attributed), ownerId, projectId, attemptId);
    this.recordOutcome(ownerId, { taskId: input.assessment.taskId, projectId, attemptId, identity: input.identity, domain: input.assessment.domain, complexity: input.assessment.complexity,
      risk: input.assessment.risk, outcome: completed.attributed && input.assessment.confidence >= 0.8 && row.check_status ? row.check_status : "unknown", cost: completed.cost, latencyMs: completed.latencyMs, occurredAt: new Date().toISOString() }, true);
  }

  recordOutcome(ownerId: string, raw: unknown, collectionEnabled: boolean): void {
    const row = outcomeSchema.parse(raw);
    if (!collectionEnabled) return;
    this.db.prepare("INSERT INTO model_allocation_outcomes VALUES(?,?,?,?) ON CONFLICT(owner_id,project_id,attempt_id) DO UPDATE SET payload=excluded.payload")
      .run(ownerId, row.projectId, row.attemptId, JSON.stringify(row));
  }

  outcomes(ownerId: string, projectIds: string[]): ModelOutcome[] {
    if (!projectIds.length) return [];
    const rows = this.db.prepare(`SELECT payload FROM model_allocation_outcomes WHERE owner_id=? AND project_id IN (${projectIds.map(() => "?").join(",")}) ORDER BY rowid DESC LIMIT 20000`)
      .all(ownerId, ...projectIds) as Array<{ payload: string }>;
    return rows.map(row => outcomeSchema.parse(JSON.parse(row.payload)));
  }

  recovery(ownerId: string, operationId: string) {
    const row = this.db.prepare("SELECT checkpoint FROM model_allocation_reservations WHERE owner_id=? AND operation_id=?").get(ownerId, operationId) as { checkpoint: string } | undefined;
    return row ? reservationSchema.parse(JSON.parse(row.checkpoint)) : null;
  }

  claimRecovery(ownerId: string, operationId: string, actual: z.infer<typeof recoveryExecutionSchema>, worktreeId: string): boolean {
    const request = this.recovery(ownerId, operationId);
    if (!request?.execution || request.execution.projectId !== actual.projectId || request.execution.conversationId !== actual.conversationId || request.checkpoint.worktreeId !== worktreeId || modelKey(request.execution.identity) !== modelKey(actual.identity)) throw new Error("Recovery scope, model or harness changed; no attempt may start");
    return Boolean(this.db.prepare("INSERT INTO model_allocation_dispatches SELECT operation_id,owner_id FROM model_allocation_reservations WHERE operation_id=? AND owner_id=? AND finished=0 ON CONFLICT DO NOTHING").run(operationId, ownerId).changes);
  }

  attemptCheck(ownerId: string, projectId: string, attemptId: string): { status: string | null; id: string | null } {
    const row = this.db.prepare("SELECT check_status AS status,check_id AS id FROM model_allocation_attempts WHERE owner_id=? AND project_id=? AND attempt_id=?").get(ownerId, projectId, attemptId) as { status: string | null; id: string | null } | undefined;
    return row ?? { status: null, id: null };
  }

  /** Call only after the dispatched writer has stopped and its external operations are resolved. */
  finish(ownerId: string, operationId: string, actualCost: number): RecoveryState {
    z.number().finite().nonnegative().parse(actualCost);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT checkpoint,result,finished FROM model_allocation_reservations WHERE owner_id=? AND operation_id=?").get(ownerId, operationId) as { checkpoint: string; result: string; finished: number } | undefined;
      if (!row) throw new Error("Recovery reservation not found for this account");
      if (row.finished) { this.db.exec("COMMIT"); return recoveryStateSchema.parse(JSON.parse(row.result)); }
      const input = reservationSchema.parse(JSON.parse(row.checkpoint));
      const task = this.db.prepare("SELECT state FROM model_allocation_tasks WHERE owner_id=? AND task_id=?").get(ownerId, input.taskId) as { state: string };
      const state = recoveryStateSchema.parse(JSON.parse(task.state));
      const next = { ...state, writerActive: false, spent: state.spent + actualCost, reserved: state.reserved - input.cost };
      this.db.prepare("UPDATE model_allocation_tasks SET state=? WHERE owner_id=? AND task_id=?").run(JSON.stringify(next), ownerId, input.taskId);
      this.db.prepare("UPDATE model_allocation_reservations SET result=?,finished=1 WHERE operation_id=?").run(JSON.stringify(next), operationId);
      this.db.exec("COMMIT");
      return next;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /** Reservation survives a restart. An existing operation never authorizes another dispatch. */
  reserve(ownerId: string, raw: unknown, initial: RecoveryState): { state: RecoveryState; dispatch: boolean } {
    const input = reservationSchema.parse(raw);
    recoveryStateSchema.parse(initial);
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT owner_id,request_hash,result FROM model_allocation_reservations WHERE operation_id=?").get(input.operationId) as { owner_id: string; request_hash: string; result: string } | undefined;
      if (previous) {
        if (previous.owner_id !== ownerId || previous.request_hash !== hash) throw new Error("Operation belongs to another recovery request");
        this.db.exec("COMMIT");
        return { state: recoveryStateSchema.parse(JSON.parse(previous.result)), dispatch: false };
      }
      const task = this.db.prepare("SELECT state FROM model_allocation_tasks WHERE owner_id=? AND task_id=?").get(ownerId, input.taskId) as { state: string } | undefined;
      const saved = task ? recoveryStateSchema.parse(JSON.parse(task.state)) : initial;
      const current = { ...saved, allowance: Math.min(saved.allowance, initial.allowance), enabled: initial.enabled, validated: initial.validated, writerActive: saved.writerActive || initial.writerActive, pendingExternalOperation: saved.pendingExternalOperation || initial.pendingExternalOperation };
      if (input.harness !== current.harness || initial.harness !== current.harness || (input.execution && input.execution.identity.harness !== current.harness)) throw new Error("Recovery must stay in the same harness");
      const next = { ...reserveRecovery(current, input.cost, input.nextQuality, input.previousQuality), writerActive: true };
      this.db.prepare("INSERT INTO model_allocation_tasks VALUES(?,?,?) ON CONFLICT(owner_id,task_id) DO UPDATE SET state=excluded.state").run(ownerId, input.taskId, JSON.stringify(next));
      this.db.prepare("INSERT INTO model_allocation_reservations VALUES(?,?,?,?,?,0)").run(input.operationId, ownerId, hash, JSON.stringify(input), JSON.stringify(next));
      this.db.exec("COMMIT");
      return { state: next, dispatch: true };
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
}
