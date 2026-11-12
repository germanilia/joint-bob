import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("routing-data.mjs summarises a fixture db", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "routing-review-data-"));
  try {
    const file = path.join(directory, "node.db");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE usage_difficulty(turn_id TEXT PRIMARY KEY, project_id TEXT, conversation_id TEXT, session_id TEXT, engine TEXT, occurred_at TEXT, payload TEXT, origin_node_id TEXT);
      CREATE TABLE model_usage_events(id TEXT PRIMARY KEY, project_id TEXT, conversation_id TEXT, session_id TEXT, engine TEXT, occurred_at TEXT, payload TEXT, origin_node_id TEXT);
      CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT);`);
    const now = Date.now(), at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    const difficulty = db.prepare("INSERT INTO usage_difficulty VALUES(?,?,?,?,?,?,?,?)");
    const row = (turnId: string, engine: string, minutes: number, payload: Record<string, unknown>) => difficulty.run(turnId, "p1", "c1", "s1", engine, at(minutes), JSON.stringify({ turnId, engine, status: "classified", ...payload }), "n");
    row("t1", "pi", 30, { level: 2, confidence: 0.9, mapped: true, reason: "routed", candidateIndex: 0, provider: "zai", modelId: "glm-fixture", thinkingLevel: "medium" });
    row("t2", "pi", 20, { status: "manual", level: null, confidence: null });
    row("t3", "claude", 10, { status: "unavailable", level: null, confidence: null, reason: "decision model unavailable" });
    row("old", "claude", 3 * 24 * 60, { level: 8, confidence: 0.9, mapped: true });
    const usage = db.prepare("INSERT INTO model_usage_events VALUES(?,?,?,?,?,?,?,?)");
    usage.run("u1", "p1", "c1", "s1", "pi", at(30), JSON.stringify({ provider: "zai", modelId: "glm-fixture", apiCostUsd: 0.25 }), "n");
    usage.run("u2", "p1", "c1", "s1", "pi", at(29), JSON.stringify({ provider: "zai", modelId: "glm-fixture", apiCostUsd: 0.5 }), "n");
    db.prepare("INSERT INTO projects VALUES('p1','Fixture project')").run();
    db.close();
    const { stdout } = await run(process.execPath, ["scripts/routing-review/routing-data.mjs", "--days", "1", "--db", file]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.days, 1);
    assert.deepEqual(summary.decisions.map((item: { turnId: string }) => item.turnId), ["t1", "t2", "t3"], "only the window, oldest first");
    assert.equal(summary.decisions[0].modelId, "glm-fixture");
    assert.equal(summary.decisions[2].reason, "decision model unavailable");
    assert.equal(summary.decisions[0].project, "Fixture project");
    assert.deepEqual(summary.costByModel, [{ engine: "pi", provider: "zai", modelId: "glm-fixture", requests: 2, apiCostUsd: 0.75 }]);
    assert.deepEqual(summary.manualAfterRouted, [{ conversationId: "c1", turnId: "t2", routedModelId: "glm-fixture" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
