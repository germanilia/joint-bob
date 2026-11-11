import { promises as fs } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { openNodeDatabase } from "./node-database.js";
import { getClusterNode } from "./cluster.js";
import { enqueueReplicationEvent, ensureReplicationSchema } from "./replication.js";
import { untilNextWrite } from "./sqlite-generation.js";
import { canonicalProjectId } from "./store.js";
import type { ProjectColor } from "./types.js";
import { closeoutRecordSchema, type CloseoutRecord } from "./conversation-closeout.js";

interface NameEntry {
  name: string;
  updatedAt: string;
}

interface NameStore {
  projects: Record<string, NameEntry>;
  sessions: Record<string, NameEntry>;
}

type OverrideScope = "projects" | "sessions" | "session_colors" | "session_classifications" | "session_done" | "session_feedback";

const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyNamesPath = process.env.JOINT_BOB_NAMES_PATH ?? process.env.PI_MOBILE_WEB_NAMES_PATH ?? path.join(repositoryRoot, ".pi-mobile-web", "names.json");
let databasePromise: Promise<DatabaseSync> | undefined;

export function projectKey(projectPath: string): string {
  return path.basename(projectPath.replace(/[/\\]+$/, "")).toLowerCase();
}

function projectsTableExists(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get());
}

// Every name lookup comes through here. Once the move to stable project ids is recorded it is
// recorded for good (the row is never removed), so a connection that has seen it stops asking.
const stableProjectIdsMigrated = new WeakSet<DatabaseSync>();

function migrateStableProjectIds(db: DatabaseSync): void {
  if (stableProjectIdsMigrated.has(db) || !projectsTableExists(db)) return;
  if (db.prepare("SELECT source FROM name_override_migrations WHERE source = 'stable-project-id-v1'").get()) {
    // Seen inside a transaction it might still be rolled back.
    if (!db.isTransaction) stableProjectIdsMigrated.add(db);
    return;
  }
  const projects = db.prepare("SELECT id, path FROM projects").all() as unknown as Array<{ id: string; path: string }>;
  const projectIds = new Set(projects.map((project) => project.id));
  const overrides = db.prepare("SELECT key, name, updated_at, origin_node_id FROM name_overrides WHERE scope = 'projects'").all() as unknown as Array<{ key: string; name: string; updated_at: string; origin_node_id: string }>;
  db.exec("BEGIN");
  try {
    const save = db.prepare(`
      INSERT INTO name_overrides (scope, key, name, updated_at, origin_node_id) VALUES ('projects', ?, ?, ?, ?)
      ON CONFLICT(scope, key) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id
    `);
    for (const override of overrides) {
      if (projectIds.has(override.key)) continue;
      const matches = projects.filter((project) => projectKey(project.path) === override.key);
      if (matches.length === 1) save.run(matches[0].id, override.name, override.updated_at, override.origin_node_id);
    }
    db.prepare("INSERT INTO name_override_migrations (source, migrated_at) VALUES ('stable-project-id-v1', ?)").run(new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function namesDatabase(): Promise<DatabaseSync> {
  if (!databasePromise) databasePromise = (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const db = openNodeDatabase(databasePath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS name_overrides (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        origin_node_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS name_override_tombstones (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        origin_node_id TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS name_override_migrations (
        source TEXT PRIMARY KEY,
        migrated_at TEXT NOT NULL
      );
    `);
    const columns = db.prepare("PRAGMA table_info(name_overrides)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "origin_node_id")) db.exec("ALTER TABLE name_overrides ADD COLUMN origin_node_id TEXT NOT NULL DEFAULT ''");
    ensureReplicationSchema(db);
    if (!db.prepare("SELECT source FROM name_override_migrations WHERE source = 'json'").get()) {
      let store: NameStore = { projects: {}, sessions: {} };
      try {
        const parsed = JSON.parse(await fs.readFile(legacyNamesPath, "utf8")) as Partial<NameStore>;
        store = { projects: parsed.projects ?? {}, sessions: parsed.sessions ?? {} };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      db.exec("BEGIN");
      try {
        const save = db.prepare("INSERT OR IGNORE INTO name_overrides (scope, key, name, updated_at) VALUES (?, ?, ?, ?)");
        for (const [key, entry] of Object.entries(store.projects)) save.run("projects", key, entry.name, entry.updatedAt);
        for (const [key, entry] of Object.entries(store.sessions)) save.run("sessions", key, entry.name, entry.updatedAt);
        db.prepare("INSERT INTO name_override_migrations (source, migrated_at) VALUES ('json', ?)").run(new Date().toISOString());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return db;
  })();
  const db = await databasePromise;
  migrateStableProjectIds(db);
  return db;
}

async function setEntry(scope: OverrideScope, key: string, name: string): Promise<void> {
  const [node, db] = await Promise.all([getClusterNode(), namesDatabase()]);
  const trimmed = name.trim();
  const updatedAt = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (trimmed) {
      db.prepare(`
        INSERT INTO name_overrides (scope, key, name, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id
      `).run(scope, key, trimmed, updatedAt, node.id);
      db.prepare("DELETE FROM name_override_tombstones WHERE scope = ? AND key = ?").run(scope, key);
    } else {
      db.prepare("DELETE FROM name_overrides WHERE scope = ? AND key = ?").run(scope, key);
      db.prepare(`
        INSERT INTO name_override_tombstones (scope, key, updated_at, origin_node_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id
      `).run(scope, key, updatedAt, node.id);
    }
    enqueueReplicationEvent(db, {
      originNodeId: node.id,
      entityType: "name.override",
      entityKey: `${scope}:${key}`,
      operation: trimmed ? "upsert" : "delete",
      payload: { scope, key, name: trimmed || null, updatedAt, originNodeId: node.id },
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** One stored override: its key and its value. */
type Row = [key: string, name: string];

// Rows as arrays are quicker to make and to compare than rows as objects. An older Node 22 has no switch for them.
const ROWS_AS_ARRAYS = typeof StatementSync.prototype.setReturnArrays === "function";

function readRows(db: DatabaseSync, scope: OverrideScope): Row[] {
  if (scope === "projects" && !projectsTableExists(db)) return [];
  // Only this function runs these two texts, so the statements kept for them are its own to switch.
  const statement = db.prepare(scope === "projects"
    ? "SELECT name_overrides.key, name_overrides.name FROM name_overrides JOIN projects ON projects.id = name_overrides.key WHERE name_overrides.scope = ?"
    : "SELECT key, name FROM name_overrides WHERE scope = ?");
  if (!ROWS_AS_ARRAYS) return (statement.all(scope) as unknown as Array<{ key: string; name: string }>).map((row) => [row.key, row.name]);
  statement.setReturnArrays(true);
  return statement.all(scope) as unknown as Row[];
}

function sameRows(left: Row[], right: Row[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index][0] !== right[index][0] || left[index][1] !== right[index][1]) return false;
  return true;
}

/**
 * Every listing asks for five of these, and each answer was built again from all its rows:
 * two thousand titles took two milliseconds, and the five together nine, a tenth of a busy
 * Mac's time.
 *
 * An answer is kept until the next write to the database (sqlite-generation.ts). That alone
 * is not enough here: the database is written many times a second (a nonce for every signed
 * request, review states for every listing), while names change a few times an hour. So
 * after a write the rows are read again and compared with the rows the last answer was built
 * from. The same rows give the same answer, and that answer is returned as it is.
 *
 * Everyone who asks gets the same object, so it is frozen: no caller can change what the
 * others read.
 */
interface Built { rows: Row[]; answer: unknown }
const builtByConnection = new WeakMap<DatabaseSync, Map<string, Built>>();

function builtFrom<T>(db: DatabaseSync, name: string, scope: OverrideScope, build: (rows: Row[]) => T): T {
  return untilNextWrite(db, `names.${name}`, () => {
    const rows = readRows(db, scope);
    let built = builtByConnection.get(db);
    if (!built) builtByConnection.set(db, built = new Map());
    const last = built.get(name);
    if (last && sameRows(last.rows, rows)) return last.answer as T;
    const answer = build(rows);
    built.set(name, { rows, answer });
    return answer;
  });
}

async function entries(scope: OverrideScope): Promise<Readonly<Record<string, string>>> {
  return builtFrom(await namesDatabase(), `entries:${scope}`, scope, (rows) => Object.freeze(Object.fromEntries(rows) as Record<string, string>));
}

export async function projectNameOverrides(): Promise<Readonly<Record<string, string>>> {
  return entries("projects");
}

export async function sessionTitleOverrides(): Promise<Readonly<Record<string, string>>> {
  return entries("sessions");
}

export async function sessionClassificationOverrides(): Promise<Readonly<Record<string, string>>> {
  return entries("session_classifications");
}

export async function setSessionClassification(conversationId: string, classification: string | null): Promise<void> {
  await setEntry("session_classifications", conversationId, classification ?? "");
}

/** Conversations the user has closed out, mapped to when they marked them done. */
export async function sessionDoneOverrides(): Promise<Readonly<Record<string, string>>> {
  return entries("session_done");
}

/** Storing the moment it was marked keeps "done" a fact with a date, not a bare flag. */
export async function setSessionDone(conversationId: string, done: boolean): Promise<void> {
  await setEntry("session_done", conversationId, done ? new Date().toISOString() : "");
}

function frozenCloseout(record: CloseoutRecord): Readonly<CloseoutRecord> {
  if (record.feedback) Object.freeze(record.feedback);
  return Object.freeze(record);
}

/** Kept in its checked form: reading and checking a thousand records took four milliseconds a call. */
export async function sessionFeedbackOverrides(): Promise<Readonly<Record<string, Readonly<CloseoutRecord>>>> {
  return builtFrom(await namesDatabase(), "feedback", "session_feedback", (rows) => Object.freeze(Object.fromEntries(rows
    .map(([id, value]) => [id, frozenCloseout(closeoutRecordSchema.parse(JSON.parse(value)))])) as Record<string, Readonly<CloseoutRecord>>));
}

export async function setSessionFeedback(conversationId: string, feedback: CloseoutRecord | null): Promise<void> {
  await setEntry("session_feedback", conversationId, feedback ? JSON.stringify(closeoutRecordSchema.parse(feedback)) : "");
}

export async function sessionColorOverrides(): Promise<Readonly<Record<string, ProjectColor>>> {
  return await entries("session_colors") as Readonly<Record<string, ProjectColor>>;
}

export async function setProjectName(projectId: string, name: string): Promise<void> {
  const canonicalId = await canonicalProjectId(projectId);
  if (!canonicalId) throw new Error("Project not found");
  await setEntry("projects", canonicalId, name);
}

/**
 * Names are keyed by conversation id, never by transcript path: a conversation
 * is named before its transcript exists, and a resumed Claude run can land in a
 * different file.
 */
export async function setSessionTitle(conversationId: string, title: string): Promise<void> {
  await setEntry("sessions", conversationId, title);
}

export async function setSessionColor(conversationId: string, color: ProjectColor | null): Promise<void> {
  await setEntry("session_colors", conversationId, color ?? "");
}

/** Names a conversation the first time something owns it, without overwriting a rename. */
export async function ensureSessionTitle(conversationId: string, title: string): Promise<void> {
  const overrides = await sessionTitleOverrides();
  if (overrides[conversationId]) return;
  await setSessionTitle(conversationId, title);
}
