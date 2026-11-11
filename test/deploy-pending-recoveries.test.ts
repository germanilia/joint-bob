import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

// The deploy script asks each machine's database how many interrupted turns it still finishes.
const deployScript = readFileSync(new URL("../scripts/deploy-installed-nodes.sh", import.meta.url), "utf8");
const lookup = /^PENDING_RECOVERIES='\n([\s\S]*?)\n'$/m.exec(deployScript)![1];
const root = path.resolve(import.meta.dirname, "..");
const live = { skip: process.env.JOINT_BOB_TEST_POSTGRES_URL ? false : "JOINT_BOB_TEST_POSTGRES_URL is not set" };

function count(dataDirectory: string, env: Record<string, string> = {}): string {
  const environment = { ...process.env, ...env };
  delete environment.JOINT_BOB_DATABASE_URL;
  Object.assign(environment, env);
  return execFileSync(process.execPath, ["--no-warnings", "-", path.join(dataDirectory, "node.db"), root], { input: lookup, env: environment, stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
}

test("a SQLite node counts its pending recoveries, and none before any update ran", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "joint-bob-deploy-recoveries-"));
  assert.equal(count(directory), "0", "no node.db yet");
  const db = new DatabaseSync(path.join(directory, "node.db"));
  db.exec("CREATE TABLE update_recoveries (id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO update_recoveries VALUES ('a', 'pending'), ('b', 'pending'), ('c', 'done')");
  db.close();
  assert.equal(count(directory), "2");
});

test("a PostgreSQL node is counted in PostgreSQL, not in its leftover node.db", live, () => {
  const url = process.env.JOINT_BOB_TEST_POSTGRES_URL!;
  const directory = mkdtempSync(path.join(os.tmpdir(), "joint-bob-deploy-recoveries-"));
  const stale = new DatabaseSync(path.join(directory, "node.db"));
  stale.exec("CREATE TABLE update_recoveries (id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO update_recoveries VALUES ('old', 'pending')");
  stale.close();
  writeFileSync(path.join(directory, "node-database-is-postgres"), "");
  const schema = `jb_deploy_${process.pid}_${Date.now()}`;
  const sql = (statements: string) => execFileSync(process.execPath, ["-e", `
    const { Client } = require(${JSON.stringify(createRequire(import.meta.url).resolve("pg"))});
    const client = new Client({ connectionString: process.env.URL });
    client.connect().then(() => client.query(process.env.SQL)).then(() => client.end());`], { env: { ...process.env, URL: url, SQL: statements } });
  const withSchema = (value: string) => `${url}${url.includes("?") ? "&" : "?"}options=-csearch_path%3D${schema}`;
  sql(`CREATE SCHEMA ${schema}`);
  try {
    assert.equal(count(directory, { JOINT_BOB_DATABASE_URL: withSchema(url) }), "0", "no update has run yet");
    sql(`CREATE TABLE ${schema}.update_recoveries (id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO ${schema}.update_recoveries VALUES ('a', 'pending'), ('b', 'pending'), ('c', 'done')`);
    assert.equal(count(directory, { JOINT_BOB_DATABASE_URL: withSchema(url) }), "2");
    assert.equal(count(directory, { JOINT_BOB_DATABASE_URL: "postgres://nobody:wrong@127.0.0.1:1/none" }), "unknown", "an unreachable database is not read as zero");
  } finally {
    sql(`DROP SCHEMA ${schema} CASCADE`);
  }
});
