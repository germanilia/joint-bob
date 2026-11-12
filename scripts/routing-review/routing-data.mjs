#!/usr/bin/env node
// Read-only summary of recent routing decisions and model cost, for the daily routing review.
// Usage: node scripts/routing-review/routing-data.mjs --days N [--db PATH]
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { days: { type: "string", default: "1" }, db: { type: "string", default: path.join(os.homedir(), ".joint-bob", "node.db") } } });
const days = Number(values.days);
if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("--days must be a whole number from 1 to 90");

const db = new DatabaseSync(values.db, { readOnly: true });
const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
const projects = new Map(db.prepare("SELECT id, name FROM projects").all().map((row) => [row.id, row.name]));

const decisions = db.prepare("SELECT turn_id, project_id, conversation_id, engine, occurred_at, payload FROM usage_difficulty WHERE occurred_at >= ? ORDER BY occurred_at")
  .all(since)
  .map((row) => {
    const record = JSON.parse(row.payload);
    return {
      turnId: row.turn_id, projectId: row.project_id, project: projects.get(row.project_id) ?? null, conversationId: row.conversation_id,
      engine: row.engine, occurredAt: row.occurred_at, status: record.status, level: record.level ?? null, confidence: record.confidence ?? null,
      reason: record.reason ?? null, candidateIndex: record.candidateIndex ?? null, provider: record.provider ?? null, modelId: record.modelId ?? null,
      thinkingLevel: record.thinkingLevel ?? null, decisionSource: record.decisionSource ?? null, outcome: record.outcome ?? null,
    };
  });

const costs = new Map();
for (const row of db.prepare("SELECT engine, payload FROM model_usage_events WHERE occurred_at >= ?").all(since)) {
  const event = JSON.parse(row.payload);
  const key = JSON.stringify([row.engine, event.provider, event.modelId]);
  const entry = costs.get(key) ?? { engine: row.engine, provider: event.provider, modelId: event.modelId, requests: 0, apiCostUsd: 0 };
  entry.requests += 1;
  entry.apiCostUsd += event.apiCostUsd ?? 0;
  costs.set(key, entry);
}
const costByModel = [...costs.values()]
  .map((entry) => ({ ...entry, apiCostUsd: Math.round(entry.apiCostUsd * 10_000) / 10_000 }))
  .sort((left, right) => right.apiCostUsd - left.apiCostUsd);

// A person picking a model by hand on the turn right after a routed one is a sign the pick was wrong.
const manualAfterRouted = [];
const lastRouted = new Map();
for (const decision of decisions) {
  if (decision.status === "classified" && decision.modelId) { lastRouted.set(decision.conversationId, decision.modelId); continue; }
  if (decision.status === "manual" && lastRouted.has(decision.conversationId)) {
    manualAfterRouted.push({ conversationId: decision.conversationId, turnId: decision.turnId, routedModelId: lastRouted.get(decision.conversationId) });
  }
  lastRouted.delete(decision.conversationId);
}

db.close();
process.stdout.write(`${JSON.stringify({ days, since, decisions, costByModel, manualAfterRouted }, null, 2)}\n`);
