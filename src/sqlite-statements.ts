import { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * Keeps each connection's compiled statements.
 *
 * Queries in this codebase call `db.prepare` where they run, so SQLite parsed and planned
 * the same text again on every call: on a busy node that was a seventh of all CPU time.
 * Importing this module makes `prepare` return the statement it compiled earlier for the
 * same text on the same connection.
 *
 * Sharing is safe for `get`, `all` and `run`, which finish and reset the statement before
 * they return. `iterate` keeps its statement open between rows, so it compiles its own.
 * SQLite recompiles a kept statement by itself when the schema changes under it.
 *
 * A connection keeps at most MAX_STATEMENTS and drops the one used longest ago. Each use is
 * numbered, and the lowest number is looked for only when a statement has to go. Moving the
 * statement to the end of the map on every use instead cost up to 0.6 microseconds a call
 * once a connection held a couple of hundred statements, tens of thousands of times a second.
 */
const MAX_STATEMENTS = 256;
interface Kept { statement: StatementSync; used: number }
const statements = new WeakMap<DatabaseSync, { kept: Map<string, Kept>; uses: number }>();
const origins = new WeakMap<StatementSync, { db: DatabaseSync; sql: string }>();
const prepare = DatabaseSync.prototype.prepare;
const close = DatabaseSync.prototype.close;
const iterate = StatementSync.prototype.iterate;

function usedLongestAgo(kept: Map<string, Kept>): string {
  let oldest = "", used = Infinity;
  for (const [sql, entry] of kept) if (entry.used < used) { oldest = sql; used = entry.used; }
  return oldest;
}

DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string): StatementSync {
  if (typeof sql !== "string") return prepare.call(this, sql);
  let own = statements.get(this);
  if (!own) statements.set(this, own = { kept: new Map(), uses: 0 });
  let entry = own.kept.get(sql);
  if (!entry) {
    const statement = prepare.call(this, sql);
    origins.set(statement, { db: this, sql });
    if (own.kept.size >= MAX_STATEMENTS) own.kept.delete(usedLongestAgo(own.kept));
    own.kept.set(sql, entry = { statement, used: 0 });
  }
  entry.used = ++own.uses;
  return entry.statement;
};

StatementSync.prototype.iterate = function (this: StatementSync, ...parameters: unknown[]) {
  const origin = origins.get(this);
  return Reflect.apply(iterate, origin ? prepare.call(origin.db, origin.sql) : this, parameters);
} as StatementSync["iterate"];

// Closing finalizes every statement of the connection; a reopened one must compile afresh.
DatabaseSync.prototype.close = function (this: DatabaseSync): void {
  statements.delete(this);
  ensured.delete(this);
  close.call(this);
};

/**
 * Runs a "make sure these tables exist" script once per connection and schema.
 *
 * Some fifty helpers run `CREATE TABLE IF NOT EXISTS …` each time they are called, many of
 * them on every request, so SQLite parsed the same scripts thousands of times a minute to
 * learn again that nothing was missing. A script made only of `CREATE TABLE` and
 * `CREATE INDEX` statements with `IF NOT EXISTS` changes nothing unless the schema changed
 * since it last ran, and SQLite counts schema changes (`PRAGMA schema_version`, which any
 * connection's change advances). Such a script is skipped while that count stands still.
 *
 * Inside a transaction it always runs and is not remembered: a rollback can return the count
 * to a value seen before with the tables gone. Any other script runs as it always did.
 *
 * The count is asked from SQLite on every such call, because another process can change the
 * schema at any moment and nothing cheaper says so. That question is nearly all a skipped
 * script costs (about 1.4 of 1.6 microseconds), so its statement is compiled once per
 * connection and kept here, apart from the statements callers share. A caller that runs its
 * script once per connection (a WeakSet) does not come here at all.
 */
const exec = DatabaseSync.prototype.exec;
const ONLY_ENSURES = /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:\(|ON\b)/i;
const ensuring = new Map<string, boolean>();
const ensured = new WeakMap<DatabaseSync, { ran: Map<string, number>; version: StatementSync }>();

function schemaVersion(version: StatementSync): number {
  return Number((version.get() as { schema_version: number | bigint }).schema_version);
}

function onlyEnsures(sql: string): boolean {
  let known = ensuring.get(sql);
  if (known === undefined) {
    const parts = sql.split(";").map((part) => part.trim()).filter(Boolean);
    known = parts.length > 0 && parts.every((part) => ONLY_ENSURES.test(part));
    if (ensuring.size >= 1024) ensuring.clear();
    ensuring.set(sql, known);
  }
  return known;
}

DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string): void {
  if (typeof sql !== "string" || this.isTransaction !== false || !onlyEnsures(sql)) { exec.call(this, sql); return; }
  let own = ensured.get(this);
  if (!own) ensured.set(this, own = { ran: new Map(), version: prepare.call(this, "PRAGMA schema_version") });
  const seen = own.ran.get(sql);
  if (seen !== undefined && seen === schemaVersion(own.version)) { scripts.skipped++; return; }
  scripts.ran++;
  exec.call(this, sql);
  own.ran.set(sql, schemaVersion(own.version));
};

const scripts = { ran: 0, skipped: 0 };
/** How many such scripts were run and how many were skipped, since this process started. */
export function ensureScriptCounts(): { ran: number; skipped: number } { return { ...scripts }; }

/**
 * Runs `write` without making its commit wait for the disk.
 *
 * Connections run with synchronous=FULL, so every commit waits for the disk to confirm the
 * write, and node:sqlite waits on the event loop: about 18 ms per commit on the homeserver,
 * where the replay nonce of every signed peer request alone took a tenth of the server's time.
 * In WAL mode synchronous=NORMAL never corrupts the database; a power cut or OS crash can only
 * lose the last commits, and the next FULL commit makes them durable too. So this is only for
 * rows that are cheap to lose: rewritten within seconds, or a cache that is fetched again.
 * Inside a transaction the caller's commit decides, so `write` runs unchanged.
 */
export function withoutDiskFlush<T>(db: DatabaseSync, write: () => T): T {
  if (db.isTransaction) return write();
  const level = Number((db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous);
  if (level <= 1) return write();
  db.prepare("PRAGMA synchronous = NORMAL").run();
  try { return write(); }
  finally { db.prepare(`PRAGMA synchronous = ${level}`).run(); }
}
