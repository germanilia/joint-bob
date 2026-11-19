import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RELAY_DECISION_KEY, systemOneFetch } from "../src/classifiers/relay-key.js";
import { answerRelayAsk } from "../src/decision-relay-proxy.js";
import { ensureRelaySchema } from "../src/relay/store.js";
import { RelayDecisionRefused } from "../src/routing-decision-relay.js";
import { systemAiDefaults } from "../src/system-ai-config.js";

const member = randomUUID();

function relayDb(serving: boolean): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureRelaySchema(db);
  const now = new Date().toISOString();
  if (serving) db.prepare("INSERT INTO relay_serving(singleton,enabled,origin,updated_at) VALUES(1,1,'https://relay.example',?)").run(now);
  db.prepare("INSERT INTO relay_machines(node_id,public_key,name,status,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(member, "key", "member", "admitted", now, now);
  return db;
}
const sharing = (share: boolean) => () => { const config = systemAiDefaults(); config.routing.shareWithRelay = share; return config; };
const refused = (status: number) => (error: unknown) => error instanceof RelayDecisionRefused && error.statusCode === status;

test("a relay shares its decision model with its machines by default, adds its own key and forwards only the body", async () => {
  assert.equal(systemAiDefaults().routing.shareWithRelay, true, "sharing is on until the relay's administrator turns it off");
  const seen: Array<{ authorization: string | null; body: string }> = [];
  const fetchImpl = (async (_url: unknown, init: RequestInit) => { seen.push({ authorization: new Headers(init.headers).get("authorization"), body: String(init.body) }); return new Response('{"answers":{}}', { status: 200 }); }) as typeof fetch;
  const answer = await answerRelayAsk(relayDb(true), member, '{"state":"x"}', new AbortController().signal, { settings: sharing(true), key: () => "relay-key", fetchImpl });
  assert.equal(answer.status, 200);
  assert.deepEqual(seen, [{ authorization: "Bearer relay-key", body: '{"state":"x"}' }]);
});

test("a relay refuses when sharing is off, when it serves no relay, to strangers, and when it has no key", async () => {
  const signal = new AbortController().signal, key = () => "relay-key";
  await assert.rejects(answerRelayAsk(relayDb(true), member, "{}", signal, { settings: sharing(false), key }), refused(403));
  await assert.rejects(answerRelayAsk(relayDb(false), member, "{}", signal, { settings: sharing(true), key }), refused(403));
  await assert.rejects(answerRelayAsk(relayDb(true), randomUUID(), "{}", signal, { settings: sharing(true), key }), refused(403));
  await assert.rejects(answerRelayAsk(relayDb(true), member, "{}", signal, { settings: sharing(true), key: () => { throw new Error("none"); } }), refused(409));
});

test("a request with a key of its own goes straight out; only the stand-in key is sent through a relay", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => { calls.push(String(input)); return new Response("{}", { status: 200 }); }) as typeof fetch;
  try {
    await systemOneFetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: "Bearer own-key" }, body: "{}" });
    assert.deepEqual(calls, ["https://api.typesafe.ai/v1/systemone"]);
    // With no relay to ask, the stand-in key fails here instead of reaching Jev.
    await assert.rejects(systemOneFetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${RELAY_DECISION_KEY}` }, body: "{}", signal: new AbortController().signal }));
    assert.equal(calls.length, 1, "the stand-in key never reaches Jev");
  } finally { globalThis.fetch = original; }
});
