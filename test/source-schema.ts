// Tables for tests, created from the statement the owning module runs: the statement is read out
// of the source. A test that names a column the module no longer has fails here, where a copy of
// the statement kept in the test would go on passing.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) found.push(full);
  }
  return found;
}

let statements: Promise<Map<string, string[]>> | undefined;

/** Every `CREATE TABLE IF NOT EXISTS <table> (...)` in src and scripts, by table. One that builds its text from a variable is left out. */
function tableStatements(): Promise<Map<string, string[]>> {
  statements ??= (async () => {
    const found = new Map<string, string[]>();
    for (const root of ["../src", "../scripts"]) {
      for (const file of await sourceFiles(new URL(root, import.meta.url).pathname)) {
        const text = await readFile(file, "utf8");
        for (const match of text.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/g)) {
          let depth = 1, end = match.index + match[0].length;
          while (depth && end < text.length) { if (text[end] === "(") depth++; else if (text[end] === ")") depth--; end++; }
          const statement = text.slice(match.index, end);
          if (!statement.includes("${")) found.set(match[1], [...(found.get(match[1]) ?? []), statement]);
        }
      }
    }
    return found;
  })();
  return statements;
}

/** Creates the tables that are not there yet, each from its module's own statement. */
export async function createSourceTables(db: DatabaseSync, tables: string[]): Promise<void> {
  const known = await tableStatements();
  for (const table of tables) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
    const created = (known.get(table) ?? []).some((statement) => { try { db.exec(statement); return true; } catch { return false; } });
    assert.ok(created, `the source has no CREATE TABLE statement for ${table} that a test can run`);
  }
}

let serial = 0;

/** Inserts a row with `values` and a made-up value in every other column: a number for a numeric column, a text no other row has for the rest. */
export function fillRow(db: DatabaseSync, table: string, values: Record<string, unknown>): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
  for (const name of Object.keys(values)) assert.ok(columns.some((column) => column.name === name), `${table} has no column ${name}`);
  const unique = ++serial;
  const row = columns.map((column) => column.name in values ? values[column.name] : /INT|REAL|NUM/i.test(column.type) ? unique : `${column.name}-${unique}`);
  db.prepare(`INSERT INTO ${table} (${columns.map((column) => column.name).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...row as never[]);
}
