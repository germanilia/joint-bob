/**
 * Holds this process's PostgreSQL connections. The stores call the database synchronously, as they
 * call SQLite, so the calling thread posts each batch here and sleeps until it is answered
 * (see `connection.ts`). Batches run one at a time, statement after statement on one connection.
 */
import { createHash } from "node:crypto";
import type { MessagePort } from "node:worker_threads";
import { workerData } from "node:worker_threads";
import pg from "pg";
import { SUPPORT_SQL } from "./support.js";

export interface Step { text: string; values?: unknown[] }
export type Request =
  | { op: "open"; url: string; schema?: string }
  | { op: "batch"; connection: number; steps: Step[]; recovery?: Step[] };
export interface WorkerError { message: string; code?: string; detail?: string; table?: string; column?: string; constraint?: string; failedAt: number }
export interface Response {
  id: number;
  connection?: number;
  results?: Array<{ rows: Record<string, unknown>[]; rowCount: number }>;
  error?: WorkerError;
  /** The connection's transaction state after the batch: I idle, T in a transaction, E failed transaction. */
  status?: string;
}

const { port, signal } = workerData as { port: MessagePort; signal: Int32Array };

// SQLite hands back numbers, text and bytes; so do these, instead of strings for 64-bit integers,
// booleans for comparisons, parsed JSON and Date objects.
const { types } = pg;
types.setTypeParser(types.builtins.INT8, Number);
types.setTypeParser(types.builtins.NUMERIC, Number);
types.setTypeParser(types.builtins.BOOL, (value: string) => (value === "t" ? 1 : 0));
// JSONB comes only from sqlite_json_typed: a value as SQLite's json_extract returns it.
types.setTypeParser(types.builtins.JSONB, (text: string) => {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed === "boolean") return parsed ? 1 : 0;
  return parsed !== null && typeof parsed === "object" ? text : parsed;
});
for (const oid of [types.builtins.JSON, types.builtins.DATE, types.builtins.TIMESTAMP, types.builtins.TIMESTAMPTZ, types.builtins.TIME, types.builtins.TIMETZ]) {
  types.setTypeParser(oid, (value: string) => value);
}

const SUPPORT_VERSION = createHash("sha256").update(SUPPORT_SQL).digest().readInt32BE(0);
// Two-key advisory lock namespace for preparing a schema; the write lock uses the other key.
const SUPPORT_LOCK = 1_246_900;

interface Entry { client: pg.Client; status: string }
const connections = new Map<number, Entry>();
let nextConnection = 1;

function value(input: unknown): unknown {
  if (input === undefined) return null;
  if (typeof input === "bigint") return input.toString();
  if (typeof input === "boolean") return input ? 1 : 0;
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return input;
}

async function open(url: string, schema: string | undefined): Promise<number> {
  const client = new pg.Client({ connectionString: url, application_name: "joint-bob" });
  const entry: Entry = { client, status: "I" };
  // A dropped connection reports on its next query; without a listener it would end the worker.
  client.on("error", () => undefined);
  await client.connect();
  (client as unknown as { connection: { on(event: "readyForQuery", listener: (message: { status: string }) => void): void } })
    .connection.on("readyForQuery", (message) => { entry.status = message.status; });
  // SQLite connections here wait up to five seconds for another writer (busy_timeout); so does this one.
  await client.query("SET lock_timeout = '5s'");
  await client.query(`SELECT pg_advisory_lock(${SUPPORT_LOCK}, 0)`);
  try {
    if (schema) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(schema)}`);
      await client.query(`SET search_path = ${pg.escapeIdentifier(schema)}`);
    }
    const prepared = await client.query("SELECT to_regclass('sqlite_pragma') IS NOT NULL AS ready");
    const version = prepared.rows[0].ready
      ? (await client.query("SELECT value FROM sqlite_pragma WHERE name = 'support_version'")).rows[0]?.value
      : undefined;
    if (version !== SUPPORT_VERSION) {
      await client.query(SUPPORT_SQL);
      await client.query("INSERT INTO sqlite_pragma VALUES ('support_version', $1) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value", [SUPPORT_VERSION]);
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${SUPPORT_LOCK}, 0)`);
  }
  const id = nextConnection++;
  connections.set(id, entry);
  return id;
}

function workerError(error: unknown, failedAt: number): WorkerError {
  const fields = error as Partial<pg.DatabaseError>;
  return {
    message: error instanceof Error ? error.message : String(error), failedAt,
    ...(fields.code ? { code: fields.code } : {}), ...(fields.detail ? { detail: fields.detail } : {}),
    ...(fields.table ? { table: fields.table } : {}), ...(fields.column ? { column: fields.column } : {}),
    ...(fields.constraint ? { constraint: fields.constraint } : {}),
  };
}

async function batch(entry: Entry, steps: Step[], recovery: Step[] = []): Promise<Omit<Response, "id">> {
  const results: NonNullable<Response["results"]> = [];
  for (const [index, step] of steps.entries()) {
    try {
      const outcome = await entry.client.query(step.text, step.values?.map(value));
      const last = Array.isArray(outcome) ? outcome.at(-1)! : outcome;
      results.push({ rows: last.rows ?? [], rowCount: last.rowCount ?? 0 });
    } catch (error) {
      for (const undo of recovery) await entry.client.query(undo.text).catch(() => undefined);
      return { results, error: workerError(error, index), status: entry.status };
    }
  }
  return { results, status: entry.status };
}

async function handle(request: Request & { id: number }): Promise<Response> {
  try {
    if (request.op === "open") return { id: request.id, connection: await open(request.url, request.schema), status: "I" };
    const entry = connections.get(request.connection);
    if (!entry) throw new Error("This PostgreSQL connection is closed");
    return { id: request.id, ...(await batch(entry, request.steps, request.recovery)) };
  } catch (error) {
    return { id: request.id, error: workerError(error, -1) };
  }
}

port.on("message", (request: Request & { id: number }) => {
  void handle(request).then((response) => {
    port.postMessage(response);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  });
});
