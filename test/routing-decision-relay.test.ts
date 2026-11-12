import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureRelaySchema } from "../src/relay/store.js";
import { answerRelayDecision, classifyThroughRelay, RelayDecisionRefused } from "../src/routing-decision-relay.js";
import { classifyForRouting } from "../src/routing-decision.js";
import { save, settingsDatabase } from "../src/settings-store.js";
import { systemAiDefaults } from "../src/system-ai-config.js";
import type { DifficultyClassifier } from "../src/classifiers/contract.js";

const options = [{ level: 2, description: "Git work" }];
const member = randomUUID();

function relayDb(serving: boolean): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureRelaySchema(db);
  const now = new Date().toISOString();
  if (serving) db.prepare("INSERT INTO relay_serving(singleton,enabled,origin,updated_at) VALUES(1,1,'https://relay.example',?)").run(now);
  db.prepare("INSERT INTO relay_machines(node_id,public_key,name,status,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(member, "key", "member", "admitted", now, now);
  return db;
}

const stub: DifficultyClassifier = { id: "typesafe", label: "stub", variableName: "TYPESAFE_AI_API_KEY", classify: async (_text, key) => ({ level: 2, score: 2, confidence: key === "relay-key" ? 0.9 : 0 }) };
const sharing = (share: boolean) => { const config = systemAiDefaults(); config.routing.shareWithRelay = share; return config; };

test("relay with sharing on answers a member", async () => {
  const answer = await answerRelayDecision(relayDb(true), member, { classifierId: "typesafe", text: "git status", options }, { settings: () => sharing(true), key: () => "relay-key", classifier: () => stub });
  assert.deepEqual(answer, { level: 2, score: 2, confidence: 0.9 });
});

test("sharing off → 403", async () => {
  await assert.rejects(answerRelayDecision(relayDb(true), member, { classifierId: "typesafe", text: "x", options }, { settings: () => sharing(false), key: () => "relay-key", classifier: () => stub }),
    (error: unknown) => error instanceof RelayDecisionRefused && error.statusCode === 403);
  await assert.rejects(answerRelayDecision(relayDb(false), member, { classifierId: "typesafe", text: "x", options }, { settings: () => sharing(true), key: () => "relay-key", classifier: () => stub }),
    (error: unknown) => error instanceof RelayDecisionRefused && error.statusCode === 403, "a machine that does not serve a relay refuses");
});

test("non-member sender → 403", async () => {
  await assert.rejects(answerRelayDecision(relayDb(true), randomUUID(), { classifierId: "typesafe", text: "x", options }, { settings: () => sharing(true), key: () => "relay-key", classifier: () => stub }),
    (error: unknown) => error instanceof RelayDecisionRefused && error.statusCode === 403);
});

test("member without local key uses the relay and records source relay:<id>", async () => {
  save(settingsDatabase(), "systemAI", JSON.stringify(systemAiDefaults()));
  const relayNodeId = randomUUID();
  const sent: unknown[] = [];
  const relay = (classifierId: "typesafe" | "laya", text: string, opts: typeof options) => classifyThroughRelay(classifierId, text, opts, {
    targets: async () => [{ relayNodeId, clusterId: randomUUID() }],
    send: async (_target, body) => { sent.push(body); return new Response(JSON.stringify({ level: 2, score: 2, confidence: 0.8 }), { status: 200 }); },
  });
  const result = await classifyForRouting("typesafe", "git status", options, { relay });
  assert.equal(result.source, `relay:${relayNodeId}`);
  assert.equal(result.classification?.level, 2);
  assert.deepEqual(sent, [{ classifierId: "typesafe", text: "git status", options }], "only the prompt and options travel; no key");
});

test("relay unreachable → reason decision model unavailable", async () => {
  const targets = async () => [{ relayNodeId: randomUUID(), clusterId: randomUUID() }];
  let calls = 0;
  const send = async () => { calls += 1; throw new Error("offline"); };
  const first = await classifyThroughRelay("typesafe", "x", options, { targets, send });
  assert.deepEqual(first, { classification: null, source: "none", reason: "decision model unavailable" });
  const refusing = await classifyThroughRelay("typesafe", "x", options, { targets: async () => [{ relayNodeId: "refusing", clusterId: "c" }], send: async () => new Response("{}", { status: 403 }) });
  assert.equal(refusing.reason, "decision model unavailable");
  assert.equal(calls, 1);
});

test("a long conversation is trimmed to the newest text, and a rejected request does not shut the relay out", async () => {
  const relayNodeId = randomUUID();
  const sent: Array<{ text: string }> = [];
  let status = 400;
  const send = async (_target: unknown, body: { text: string }) => { sent.push(body); return new Response(JSON.stringify({ level: 2, score: 2, confidence: 0.8 }), { status }); };
  const targets = async () => [{ relayNodeId, clusterId: randomUUID() }];
  const long = `${"old ".repeat(40_000)}NEWEST`;
  const rejected = await classifyThroughRelay("typesafe", long, options, { targets, send });
  assert.equal(rejected.reason, "decision model unavailable");
  assert.ok(sent[0].text.length <= 120_000 && sent[0].text.endsWith("NEWEST"), "only the newest 120,000 characters travel");
  status = 200;
  const next = await classifyThroughRelay("typesafe", "git status", options, { targets, send });
  assert.equal(next.source, `relay:${relayNodeId}`, "a 400 is not remembered as a refusal");
});
