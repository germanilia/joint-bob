import type { DatabaseSync, StatementSync } from "node:sqlite";

/* Answers that are read far more often than they change (a project's row, who may see it, a setting)
   are kept between writes. "Between writes" is exact, not a guess: SQLite counts every change this
   connection makes (total_changes), notices every commit another connection makes
   (PRAGMA data_version) and numbers every change of schema (PRAGMA schema_version). An answer is
   reused only while all three stand still, so it can never be older than the last write to the
   database, whoever made it and whatever table it touched.

   Nothing is kept while the connection is inside a transaction: what a transaction reads may be
   rolled back, and a rollback moves none of the three numbers back.

   Reading the numbers costs a few microseconds. A lookup worth keeping costs several
   queries; the ones kept here were a third of a busy node's time, asked thousands of times a
   second with the same arguments.

   A database that cannot give the numbers (another backend) keeps nothing: every call computes. */

interface Generation { changes: StatementSync; version: StatementSync; schema: StatementSync; stamp: string | undefined; entries: Map<string, unknown> }

const generations = new WeakMap<DatabaseSync, Generation | null>();
/** Entries kept per connection before the oldest answers go: bounds memory on a node with many projects and peers. */
const MAX_ENTRIES = 20_000;

function generationOf(db: DatabaseSync): Generation | null {
  const held = generations.get(db);
  if (held !== undefined) return held;
  let made: Generation | null;
  try {
    // Without it a transaction cannot be told from none, and an answer read inside one that rolls back would be kept.
    if (typeof (db as { isTransaction?: unknown }).isTransaction !== "boolean") throw new Error("This runtime does not say whether a transaction is open");
    made = { changes: db.prepare("SELECT total_changes() AS c"), version: db.prepare("PRAGMA data_version"), schema: db.prepare("PRAGMA schema_version"), stamp: undefined, entries: new Map() };
    // Asked once now: a backend without them fails here and is never asked again.
    if (stampOf(made) === undefined) made = null;
  } catch { made = null; }
  generations.set(db, made);
  return made;
}

/** The connection's write stamp, or undefined when it cannot be read (closed database, another backend). */
function stampOf(generation: Generation): string | undefined {
  try {
    const changes = (generation.changes.get() as { c: number | bigint }).c;
    const version = (generation.version.get() as { data_version: number | bigint }).data_version;
    const schema = (generation.schema.get() as { schema_version: number | bigint }).schema_version;
    if (changes === undefined || version === undefined || schema === undefined) return undefined;
    return `${changes}:${version}:${schema}`;
  } catch { return undefined; }
}

/**
 * `compute()`'s answer for `key`, kept until the next write to the database. `key` must name the
 * function and every argument the answer depends on. The answer must depend on the database alone:
 * nothing read from the clock, the environment, or another database. What is returned is the very
 * object that was kept, so callers must not change it.
 */
export function untilNextWrite<T>(db: DatabaseSync, key: string, compute: () => T): T {
  const generation = generationOf(db);
  if (!generation) return compute();
  const stamp = stampOf(generation);
  if (stamp === undefined) return compute();
  if (stamp !== generation.stamp) { generation.entries.clear(); generation.stamp = stamp; }
  if (generation.entries.has(key)) return generation.entries.get(key) as T;
  const value = compute();
  // Inside a transaction the answer may describe rows that are rolled back later.
  if (db.isTransaction) return value;
  // A compute that wrote (a schema it created, a row it repaired) moved the stamp: its answer belongs to no generation.
  if (stampOf(generation) !== stamp) return value;
  if (generation.entries.size >= MAX_ENTRIES) generation.entries.clear();
  generation.entries.set(key, value);
  return value;
}

/** Tests: how many answers a connection holds now. */
export function keptAnswers(db: DatabaseSync): number {
  return generations.get(db)?.entries.size ?? 0;
}
