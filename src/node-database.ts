import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PostgresDatabase } from "./postgres/connection.js";

/**
 * Where the node keeps its own database. Without `JOINT_BOB_DATABASE_URL` it is SQLite's
 * `node.db` in the data directory. With it, the same tables live in that PostgreSQL database,
 * read when the process starts; each node needs a database of its own.
 *
 * The name is Joint Bob's own: `DATABASE_URL` belongs to the projects' PostgreSQL secrets,
 * which are exported into agents' shells.
 */
export const DATABASE_URL_VARIABLE = "JOINT_BOB_DATABASE_URL";

/* Written beside node.db while the node uses PostgreSQL, so a process started without the
   variable stops instead of quietly beginning an empty SQLite database. */
const POSTGRES_MARKER = "node-database-is-postgres";

function postgresUrl(): string | undefined { return process.env[DATABASE_URL_VARIABLE]?.trim() || undefined; }

export function nodeDatabaseIsPostgres(): boolean { return postgresUrl() !== undefined; }

function testContext(): boolean { return Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === "test"; }

/** Opens the node database whose SQLite file would be `file` (always `<data directory>/node.db`). */
export function openNodeDatabase(file: string): DatabaseSync {
  if (path.basename(file) !== "node.db") throw new Error(`openNodeDatabase opens node.db, not ${file}`);
  const directory = path.dirname(file);
  const marker = path.join(directory, POSTGRES_MARKER);
  const url = postgresUrl();
  if (!url) {
    if (existsSync(marker)) {
      throw new Error(`This node keeps its database in PostgreSQL (${marker}). Set ${DATABASE_URL_VARIABLE} in ~/.joint-bob/env and restart, or delete that file to start again with an empty SQLite database.`);
    }
    return new DatabaseSync(file);
  }
  if (!existsSync(marker)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(marker, `This node's database is in PostgreSQL (${DATABASE_URL_VARIABLE}).\n`, { mode: 0o600 });
  }
  // Tests give every data directory a schema of its own, as each has its own node.db.
  // Named from the real path: two spellings of one folder (macOS /var and /private/var) are one node.db.
  const schema = testContext() ? `jb_test_${createHash("sha256").update(realpathSync(directory)).digest("hex").slice(0, 16)}` : undefined;
  return new PostgresDatabase(url, schema) as unknown as DatabaseSync;
}

/** Which database this node uses, checked by connecting; the address never includes the password. */
export function describeNodeDatabase(directory: string): string {
  const url = postgresUrl();
  if (!url) return `SQLite (${path.join(directory, "node.db")})`;
  const db = openNodeDatabase(path.join(directory, "node.db"));
  db.close();
  const parsed = new URL(url);
  return `PostgreSQL (${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname})`;
}
