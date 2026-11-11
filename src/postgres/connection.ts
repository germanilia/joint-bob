/**
 * A PostgreSQL connection the stores use exactly as they use `DatabaseSync`: `prepare(sql)` with
 * `get`/`all`/`run`/`iterate`, `exec(script)` and `isTransaction`, all synchronous.
 *
 * The connection lives in a worker thread (`worker.ts`); each call posts a batch there and sleeps
 * on `Atomics.wait` until the answer arrives, the way node:sqlite blocks on its own disk I/O.
 *
 * SQLite's behaviour is kept where the stores depend on it:
 * - one writer at a time: every write takes a database-wide advisory lock for the rest of its
 *   transaction, as SQLite's write lock, and waits up to five seconds for it (busy_timeout);
 * - a failed statement inside a transaction fails alone, as in SQLite, because each one runs
 *   under its own savepoint;
 * - a SAVEPOINT outside a transaction opens one, and releasing it commits;
 * - `sqlite_master`, `PRAGMA table_info`, `user_version` and `schema_version` answer from
 *   bookkeeping this class keeps beside each schema change.
 */
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import {
  planStatement, splitStatements, tokenize,
  type Plan, type Query, type SchemaChange, type SchemaLookup, type TableShape, type Token, type TransactionOp,
} from "./sql-translation.js";
import type { Request, Response, Step, WorkerError } from "./worker.js";

type Row = Record<string, unknown>;
type Args = unknown[];
interface Outcome { rows: Row[]; changes: number }

const ANSWER_TIMEOUT_MS = 120_000;
// Two-key advisory lock: the first key is Joint Bob's, the second the schema's.
const WRITE_LOCK: Step = { text: "SELECT pg_advisory_xact_lock(1246901, hashtext(current_schema()))" };
const STATEMENT_SAVEPOINT = "jb_statement";

let bridge: { port: MessagePort; signal: Int32Array; nextId: number } | undefined;

function workerSource(): { url: URL; eval?: string } {
  const url = new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
  if (!import.meta.url.endsWith(".ts")) return { url };
  // A checkout runs TypeScript: register tsx in the worker before importing its entry (see file-sync/bridge.ts).
  const tsx = import.meta.resolve("tsx/esm/api");
  return { url, eval: `import(${JSON.stringify(tsx)}).then(({ register }) => { register(); return import(${JSON.stringify(url.href)}); });` };
}

function call(request: Request): Response {
  if (!bridge) {
    const { port1, port2 } = new MessageChannel();
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const source = workerSource();
    const options = { workerData: { port: port2, signal }, transferList: [port2], execArgv: [] };
    const worker = source.eval ? new Worker(source.eval, { ...options, eval: true }) : new Worker(source.url, options);
    worker.unref();
    port1.unref();
    bridge = { port: port1, signal, nextId: 1 };
  }
  const id = bridge.nextId++;
  Atomics.store(bridge.signal, 0, 0);
  bridge.port.postMessage({ ...request, id });
  if (Atomics.wait(bridge.signal, 0, 0, ANSWER_TIMEOUT_MS) === "timed-out") {
    bridge = undefined;
    throw new Error(`PostgreSQL did not answer within ${ANSWER_TIMEOUT_MS / 1000} s`);
  }
  const message = receiveMessageOnPort(bridge.port)?.message as Response | undefined;
  if (!message || message.id !== id) throw new Error("PostgreSQL worker answered out of turn");
  return message;
}

/** The SQLite error message the stores already recognise, with PostgreSQL's own after it. */
export function sqliteError(error: WorkerError): Error {
  const columns = /^Key \((.+?)\)=/.exec(error.detail ?? "")?.[1].split(", ").map((column) => `${error.table}.${column.replace(/^"|"$/g, "")}`).join(", ");
  const sqlite: Record<string, string | undefined> = {
    "23505": `UNIQUE constraint failed: ${columns ?? error.constraint}`,
    "23502": `NOT NULL constraint failed: ${error.table}.${error.column}`,
    "23503": "FOREIGN KEY constraint failed",
    "23514": `CHECK constraint failed: ${error.constraint}`,
    "55P03": "database is locked",
    "40P01": "database is locked",
    "42P01": `no such table: ${/relation "(.+?)"/.exec(error.message)?.[1]}`,
    "42703": `no such column: ${/column "(.+?)"/.exec(error.message)?.[1]}`,
    "42701": `duplicate column name: ${/column "(.+?)"/.exec(error.message)?.[1]}`,
  };
  const message = error.code && sqlite[error.code] ? `${sqlite[error.code]} (PostgreSQL ${error.code}: ${error.message})` : error.message;
  return Object.assign(new Error(message), { postgresCode: error.code });
}

function castFor(argument: unknown): string {
  if (typeof argument === "number") return Number.isInteger(argument) ? "bigint" : "double precision";
  if (typeof argument === "bigint") return "bigint";
  if (argument instanceof Uint8Array) return "bytea";
  return "text";
}

export class PostgresStatement {
  private arrays = false;
  constructor(private readonly db: PostgresDatabase, readonly sourceSQL: string) {}
  /** As StatementSync: rows come back as arrays of their values, in column order. */
  setReturnArrays(enabled: boolean): void { this.arrays = enabled; }
  private rows(args: Args): Row[] {
    const rows = this.db.runOne(this.sourceSQL, args).rows;
    return this.arrays ? rows.map((row) => Object.values(row) as unknown as Row) : rows;
  }
  get(...args: Args): Row | undefined { return this.rows(args)[0]; }
  all(...args: Args): Row[] { return this.rows(args); }
  run(...args: Args): { changes: number; lastInsertRowid: number } { return { changes: this.db.runOne(this.sourceSQL, args).changes, lastInsertRowid: 0 }; }
  iterate(...args: Args): IterableIterator<Row> { return this.rows(args)[Symbol.iterator](); }
}

/*
 * A store's handle owns a PostgreSQL connection only while it has a transaction open. Statements
 * outside one share a connection per database, which is safe because each call finishes before the
 * next starts: an autocommit write is a whole BEGIN…COMMIT in one batch. So a process holds one
 * connection plus one per transaction open at that moment, where SQLite let every handle have its own.
 */
interface Pool { url: string; schema?: string; shared: number; idle: number[] }
const pools = new Map<string, Pool>();

function openConnection(url: string, schema: string | undefined): number {
  const answer = call({ op: "open", url, ...(schema ? { schema } : {}) });
  if (answer.error) throw sqliteError(answer.error);
  return answer.connection!;
}

function poolFor(url: string, schema: string | undefined): Pool {
  const key = `${schema ?? ""}\0${url}`;
  let pool = pools.get(key);
  if (!pool) pools.set(key, pool = { url, ...(schema ? { schema } : {}), shared: openConnection(url, schema), idle: [] });
  return pool;
}

export class PostgresDatabase implements SchemaLookup {
  private readonly pool: Pool;
  private open = true;
  /** The connection this handle's open transaction runs on. */
  private transactionConnection: number | undefined;
  private status = "I";
  private holdsWriteLock = false;
  private savepoints: string[] = [];
  /** The savepoint that opened the transaction, as SQLite lets one do. */
  private opener: string | undefined;
  /** Each SQL text's statements, planned when first run: a script's later statements may need tables its earlier ones create. */
  private readonly plans = new Map<string, Array<{ tokens: Token[]; plan?: Plan }>>();
  private readonly shapes = new Map<string, TableShape | undefined>();
  private objects: Set<string> | undefined;

  constructor(url: string, schema?: string) {
    this.pool = poolFor(url, schema);
  }

  get isOpen(): boolean { return this.open; }
  get isTransaction(): boolean { return this.status !== "I"; }

  prepare(sql: string): PostgresStatement {
    if (this.statements(sql).length !== 1) throw new Error("prepare() takes exactly one SQL statement");
    return new PostgresStatement(this, sql);
  }

  exec(sql: string): void {
    for (const statement of this.statements(sql)) this.execute(this.plan(statement), []);
  }

  /** As SQLite's close, rolls back a transaction left open. */
  close(): void {
    if (!this.open) throw new Error("database is not open");
    if (this.isTransaction) this.send([{ text: "ROLLBACK" }]);
    this.open = false;
  }

  runOne(sql: string, args: Args): Outcome { return this.execute(this.plan(this.statements(sql)[0]), args); }

  table(name: string): TableShape | undefined {
    const key = name.toLowerCase();
    if (!this.shapes.has(key)) {
      const row = this.batch([{ text: "SELECT columns, keys FROM sqlite_table_shape($1)", values: [name] }], false).rows[0];
      this.shapes.set(key, row?.columns ? { columns: row.columns as string[], uniqueKeys: JSON.parse(row.keys as string) as string[][] } : undefined);
    }
    return this.shapes.get(key);
  }

  private statements(sql: string): Array<{ tokens: Token[]; plan?: Plan }> {
    let statements = this.plans.get(sql);
    if (!statements) {
      statements = splitStatements(tokenize(sql)).map((tokens) => ({ tokens }));
      if (this.plans.size >= 2048) this.plans.clear();
      this.plans.set(sql, statements);
    }
    return statements;
  }

  private plan(statement: { tokens: Token[]; plan?: Plan }): Plan {
    statement.plan ??= planStatement(statement.tokens, this);
    return statement.plan;
  }

  private execute(plan: Plan, args: Args): Outcome {
    if (plan.kind === "rows") return { rows: plan.rows, changes: 0 };
    if (plan.kind === "transaction") { this.transaction(plan.op, plan.name); return { rows: [], changes: 0 }; }
    if (plan.kind === "pragmaWrite") {
      return this.batch([{ text: "INSERT INTO sqlite_pragma VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value", values: [plan.name, plan.value] }], true);
    }
    if (plan.kind === "updateOrIgnore") return this.updateOrIgnore(plan, args);
    if (plan.change?.op === "create" && plan.change.ifNotExists && this.knownObjects().has(plan.change.name.toLowerCase())) return { rows: [], changes: 0 };
    const outcome = this.query(plan.query, args, plan.write, plan.change);
    if (plan.change) this.changed(plan.change);
    if (!plan.keepsRowid) for (const row of outcome.rows) delete row.rowid;
    return outcome;
  }

  /** Runs a statement; when PostgreSQL cannot tell a parameter's type, casts it as its value is. */
  private query(query: Query, args: Args, write: boolean, change?: SchemaChange): Outcome {
    for (;;) {
      const values = query.args.map((index) => args[index] ?? null);
      const steps = [{ text: query.text, values }, ...(change ? bookkeeping(change) : [])];
      try {
        return this.batch(steps, write || Boolean(change));
      } catch (error) {
        const parameter = (error as { postgresCode?: string }).postgresCode === "42P18" && /parameter \$(\d+)/.exec((error as Error).message)?.[1];
        if (!parameter) throw error;
        query.text = query.text.replace(new RegExp(`\\$${parameter}(?![0-9])`, "g"), `$$${parameter}::${castFor(values[Number(parameter) - 1])}`);
      }
    }
  }

  private updateOrIgnore(plan: Extract<Plan, { kind: "updateOrIgnore" }>, args: Args): Outcome {
    const ids = this.query(plan.select, args, false).rows.map((row) => row.rowid);
    let changes = 0;
    for (const id of ids) {
      try { changes += this.query(plan.update, [...args, id], true).changes; }
      catch (error) { if ((error as { postgresCode?: string }).postgresCode !== "23505") throw error; }
    }
    return { rows: [], changes };
  }

  /** Runs steps as SQLite would run one statement, in or out of a transaction. */
  private batch(steps: Step[], write: boolean): Outcome {
    let request: Step[], recovery: Step[], first: number;
    if (!this.isTransaction) {
      [request, recovery, first] = write ? [[{ text: "BEGIN" }, WRITE_LOCK, ...steps, { text: "COMMIT" }], [{ text: "ROLLBACK" }], 2] : [steps, [], 0];
    } else {
      const lock = write && !this.holdsWriteLock ? [WRITE_LOCK] : [];
      request = [{ text: `SAVEPOINT ${STATEMENT_SAVEPOINT}` }, ...lock, ...steps, { text: `RELEASE SAVEPOINT ${STATEMENT_SAVEPOINT}` }];
      recovery = [{ text: `ROLLBACK TO SAVEPOINT ${STATEMENT_SAVEPOINT}` }, { text: `RELEASE SAVEPOINT ${STATEMENT_SAVEPOINT}` }];
      first = 1 + lock.length;
    }
    const answer = this.send(request, recovery);
    if (this.isTransaction && write) this.holdsWriteLock = true;
    const result = answer.results![first];
    return { rows: result.rows, changes: result.rowCount };
  }

  /** Sends a batch; `opens` when it leaves a transaction open, which then has a connection of its own. */
  private send(steps: Step[], recovery: Step[] = [], opens = false): Response {
    if (!this.open) throw new Error("database is not open");
    if (opens) this.transactionConnection ??= this.pool.idle.pop() ?? openConnection(this.pool.url, this.pool.schema);
    const answer = call({ op: "batch", connection: this.transactionConnection ?? this.pool.shared, steps, recovery });
    this.status = answer.status ?? this.status;
    if (this.status === "I") this.ended();
    if (answer.error) throw sqliteError(answer.error);
    return answer;
  }

  private ended(): void {
    if (this.transactionConnection !== undefined) this.pool.idle.push(this.transactionConnection);
    this.transactionConnection = undefined;
    this.holdsWriteLock = false;
    this.savepoints = [];
    this.opener = undefined;
  }

  private transaction(op: TransactionOp, name?: string): void {
    const savepoint = name && `SAVEPOINT ${quote(name)}`;
    if (op === "begin" || op === "beginImmediate") {
      if (this.isTransaction) throw new Error("cannot start a transaction within a transaction");
      this.send(op === "begin" ? [{ text: "BEGIN" }] : [{ text: "BEGIN" }, WRITE_LOCK], [{ text: "ROLLBACK" }], true);
      this.holdsWriteLock = op === "beginImmediate";
    } else if (op === "commit" || op === "rollback") {
      if (!this.isTransaction) throw new Error(`cannot ${op} - no transaction is active`);
      this.send([{ text: op.toUpperCase() }]);
      if (op === "rollback") this.forgetSchema();
    } else if (op === "savepoint") {
      if (this.isTransaction) this.send([{ text: savepoint! }]);
      else { this.send([{ text: "BEGIN" }, { text: savepoint! }], [{ text: "ROLLBACK" }], true); this.opener = name; }
      this.savepoints.push(name!);
    } else {
      const at = this.savepoints.lastIndexOf(name!);
      if (at < 0) throw new Error(`no such savepoint: ${name}`);
      if (op === "rollbackTo") {
        this.send([{ text: `ROLLBACK TO ${savepoint}` }]);
        this.savepoints.length = at + 1;
        this.holdsWriteLock = false;
        this.forgetSchema();
      } else if (at === 0 && this.opener === name) this.send([{ text: "COMMIT" }]);
      else { this.send([{ text: `RELEASE ${savepoint}` }]); this.savepoints.length = at; }
    }
  }

  private knownObjects(): Set<string> {
    this.objects ??= new Set(this.batch([{ text: "SELECT name FROM sqlite_master" }], false).rows.map((row) => String(row.name).toLowerCase()));
    return this.objects;
  }

  /** A rollback can undo schema changes this connection remembered; it learns the schema again. */
  private forgetSchema(): void {
    this.objects = undefined;
    this.shapes.clear();
    for (const statements of this.plans.values()) for (const statement of statements) if (statement.plan && "tables" in statement.plan && statement.plan.tables.length) delete statement.plan;
  }

  /** Forgets what a schema change made stale: table shapes, the plans built on them, known names. */
  private changed(change: SchemaChange): void {
    const tables = change.op === "renameTable" ? [change.from, change.to] : "table" in change ? [change.table] : [change.name];
    const stale = new Set(tables.map((table) => table.toLowerCase()));
    for (const table of stale) this.shapes.delete(table);
    for (const statements of this.plans.values()) {
      for (const statement of statements) {
        if (statement.plan && "tables" in statement.plan && statement.plan.tables.some((table) => stale.has(table.toLowerCase()))) delete statement.plan;
      }
    }
    if (change.op === "drop" || change.op === "renameTable") this.objects = undefined;
    if (change.op === "create") this.objects?.add(change.name.toLowerCase());
  }
}

function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

/** Keeps sqlite_master and the schema counter as SQLite would after `change`. */
function bookkeeping(change: SchemaChange): Step[] {
  const bump: Step = { text: "UPDATE sqlite_pragma SET value = value + 1 WHERE name = 'schema_version'" };
  if (change.op === "create") {
    return [{ text: "INSERT INTO sqlite_master (type, name, tbl_name, sql) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING", values: [change.type, change.name, change.table, change.sql] }, bump];
  }
  if (change.op === "drop") {
    const text = change.type === "table" ? "DELETE FROM sqlite_master WHERE name = $1 OR tbl_name = $1" : "DELETE FROM sqlite_master WHERE name = $1";
    return [{ text, values: [change.name] }, bump];
  }
  if (change.op === "renameTable") {
    return [
      { text: "UPDATE sqlite_master SET tbl_name = $2, sql = regexp_replace(sql, $3, $2) WHERE tbl_name = $1", values: [change.from, change.to, `\\m${change.from}\\M`] },
      { text: "UPDATE sqlite_master SET name = $2 WHERE name = $1", values: [change.from, change.to] },
      bump,
    ];
  }
  if (change.op === "addColumn") {
    // SQLite appends the definition inside the table's closing parenthesis.
    const text = `UPDATE sqlite_master SET sql = left(sql, length(sql) - strpos(reverse(sql), ')')) || ', ' || $2 || right(sql, strpos(reverse(sql), ')')) WHERE type = 'table' AND name = $1`;
    return [{ text, values: [change.table, change.definition] }, bump];
  }
  if (change.op === "renameColumn") {
    return [{ text: `UPDATE sqlite_master SET sql = regexp_replace(sql, $2, $3, 'g') WHERE tbl_name = $1 AND type = 'table'`, values: [change.table, `\\m${change.from}\\M`, change.to] }, bump];
  }
  return [bump];
}
