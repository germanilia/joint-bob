import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { outcomeSchema, type ModelOutcome } from "./model-evidence.js";
import { recoveryStateSchema, reserveRecovery, type RecoveryState } from "./model-allocation.js";

const reservationSchema = z.object({
  taskId: z.string().min(1).max(200), operationId: z.string().min(1).max(200), cost: z.number().finite().nonnegative(),
  nextQuality: z.number().min(0).max(1), previousQuality: z.number().min(0).max(1),
  checkpoint: z.object({ worktreeId: z.string().min(1).max(200), baseCommit: z.string().regex(/^[a-f0-9]{40}$/), candidateCommit: z.string().regex(/^[a-f0-9]{40}$/), checkIds: z.array(z.string().min(1).max(200)).max(100) }).strict(),
}).strict();

/** Machine-local derived evidence only. No transcript, prompt, credential or command columns. */
export class AllocationStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS model_allocation_outcomes(owner_id TEXT NOT NULL,project_id TEXT NOT NULL,attempt_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner_id,project_id,attempt_id));
      CREATE TABLE IF NOT EXISTS model_allocation_tasks(owner_id TEXT NOT NULL,task_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner_id,task_id));
      CREATE TABLE IF NOT EXISTS model_allocation_reservations(operation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,request_hash TEXT NOT NULL,checkpoint TEXT NOT NULL,result TEXT NOT NULL,finished INTEGER NOT NULL DEFAULT 0);`);
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
      const current = task ? recoveryStateSchema.parse(JSON.parse(task.state)) : initial;
      const next = { ...reserveRecovery(current, input.cost, input.nextQuality, input.previousQuality), writerActive: true };
      this.db.prepare("INSERT INTO model_allocation_tasks VALUES(?,?,?) ON CONFLICT(owner_id,task_id) DO UPDATE SET state=excluded.state").run(ownerId, input.taskId, JSON.stringify(next));
      this.db.prepare("INSERT INTO model_allocation_reservations VALUES(?,?,?,?,?,0)").run(input.operationId, ownerId, hash, JSON.stringify(input), JSON.stringify(next));
      this.db.exec("COMMIT");
      return { state: next, dispatch: true };
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
}
