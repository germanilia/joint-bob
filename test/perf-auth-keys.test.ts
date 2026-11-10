import assert from "node:assert/strict";
import crypto, { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { getClusterNode } from "../src/cluster.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey, pinnedClusterPublicKey } from "../src/cluster-identity.js";
import { signClusterRequest, verifyClusterRequest } from "../src/cluster-protocol.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { canonicalPublicKey, signMessage, signRequest, verifyMessage, verifyRequest } from "../src/file-sync/signing.js";
import { captureClusterRawBody, requireHttpAuth } from "../src/server/http-auth.js";
import { counting, countingAsync } from "./perf-statement-counter.js";

/* A signed machine request used to read the same keys from their text again and again, and to
   make sure of this node's own identity every time. Both are done once now. These tests pin what
   must not be kept: whether a signature is good, a nonce, or a key that did not pass. */

const SENDER = "11111111-1111-4111-8111-111111111111";
const RECIPIENT = "22222222-2222-4222-8222-222222222222";
const NOW = 1_700_000_000_000;

/** Runs `work` and counts how often a key was read from text or bytes and how often a signature was checked. */
function countingCrypto<T>(work: () => T): { result: T; keysRead: number; checked: number } {
  const original = { createPublicKey: crypto.createPublicKey, verify: crypto.verify };
  let keysRead = 0, checked = 0;
  crypto.createPublicKey = ((...args: Parameters<typeof crypto.createPublicKey>) => { keysRead++; return original.createPublicKey(...args); }) as typeof crypto.createPublicKey;
  crypto.verify = ((...args: unknown[]) => { checked++; return (original.verify as (...all: unknown[]) => unknown)(...args); }) as typeof crypto.verify;
  syncBuiltinESMExports();
  try {
    const result = work();
    return { result, keysRead, checked };
  } finally {
    Object.assign(crypto, original);
    syncBuiltinESMExports();
  }
}

function keyPair(): { pem: string; privateKey: crypto.KeyObject } {
  const keys = generateKeyPairSync("ed25519");
  return { pem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey: keys.privateKey };
}

test("a key is read from its text once, and every signature is still checked", () => {
  const { pem, privateKey } = keyPair();
  const good = signMessage(privateKey, "perf", "payload"), other = signMessage(privateKey, "perf", "another payload");
  const first = countingCrypto(() => verifyMessage(pem, "perf", "payload", good));
  assert.deepEqual([first.result, first.checked], [true, 1]);
  assert.ok(first.keysRead > 0);

  const repeated = countingCrypto(() => Array.from({ length: 20 }, () => verifyMessage(pem, "perf", "payload", good)));
  assert.ok(repeated.result.every(Boolean));
  assert.equal(repeated.keysRead, 0, "the key is not read from its text again");
  assert.equal(repeated.checked, 20, "each signature is checked");

  // The same key, a signature that is well formed and wrong: refused, before and after a good one.
  const mixed = countingCrypto(() => [verifyMessage(pem, "perf", "payload", other), verifyMessage(pem, "perf", "payload", good), verifyMessage(pem, "perf", "payload", other), verifyMessage(pem, "perf", "changed", good), verifyMessage(pem, "other-domain", "payload", good)]);
  assert.deepEqual(mixed.result, [false, true, false, false, false]);
  assert.equal(mixed.checked, 5);
  assert.equal(mixed.keysRead, 0);

  const canonical = countingCrypto(() => [canonicalPublicKey(pem), canonicalPublicKey(pem)]);
  assert.deepEqual(canonical.result, [pem, pem]);
  assert.equal(canonical.keysRead, 0);
});

test("a key written another way gives the same key, and only keys that passed are kept", () => {
  const { pem, privateKey } = keyPair();
  const signature = signMessage(privateKey, "perf", "payload");
  const spelled = `${pem.replace(/\n/g, "\r\n")}\r\n`;
  assert.notEqual(spelled, pem);
  assert.equal(canonicalPublicKey(spelled), pem);
  assert.equal(canonicalPublicKey(spelled), pem);
  assert.equal(verifyMessage(spelled, "perf", "payload", signature), true);

  const privateText = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.throws(() => canonicalPublicKey("not a key"), /Cluster public key is invalid/);
    assert.throws(() => canonicalPublicKey(privateText), /must be an Ed25519 public key/);
    assert.throws(() => canonicalPublicKey(rsa), /must be Ed25519/);
    assert.equal(verifyMessage("not a key", "perf", "payload", signature), false);
    assert.equal(verifyMessage(privateText, "perf", "payload", signature), false);
    assert.equal(verifyMessage(rsa, "perf", "payload", signature), false);
  }
  // A text that failed is read again each time: nothing about it was kept.
  const failed = countingCrypto(() => { try { canonicalPublicKey(rsa); } catch { /* expected */ } });
  assert.ok(failed.keysRead > 0);
});

test("keys nobody asks for again are let go, and answers stay right meanwhile", () => {
  const first = keyPair();
  const firstSignature = signMessage(first.privateKey, "perf", "payload");
  assert.equal(verifyMessage(first.pem, "perf", "payload", firstSignature), true);
  for (let index = 0; index < 300; index++) {
    const { pem, privateKey } = keyPair();
    const signature = signMessage(privateKey, "perf", `payload ${index}`);
    assert.equal(verifyMessage(pem, "perf", `payload ${index}`, signature), true);
    assert.equal(verifyMessage(pem, "perf", "payload", firstSignature), false, "another key's signature");
    assert.equal(canonicalPublicKey(pem), pem);
  }
  // More keys went by than are kept. The first one is read from its text again, and still verifies.
  const again = countingCrypto(() => verifyMessage(first.pem, "perf", "payload", firstSignature));
  assert.equal(again.result, true);
  assert.ok(again.keysRead > 0, "the kept keys are bounded");
});

test("a request from a pinned key verifies every time it is asked, and only with that key", () => {
  const sender = keyPair(), stranger = keyPair();
  const body = Buffer.from('{"since":0}');
  const header = signRequest(sender.privateKey, SENDER, RECIPIENT, "POST", "/api/cluster/v2/x", body, NOW);
  const forged = signRequest(stranger.privateKey, SENDER, RECIPIENT, "POST", "/api/cluster/v2/x", body, NOW);
  const verify = (authorization: string) => verifyRequest(RECIPIENT, "POST", "/api/cluster/v2/x", body, authorization, () => sender.pem, NOW);
  const counted = countingCrypto(() => {
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(verify(header).senderNodeId, SENDER);
      assert.throws(() => verify(forged), /Invalid cluster request/, "signed by another key in the sender's name");
      assert.throws(() => verifyRequest(RECIPIENT, "POST", "/api/cluster/v2/x", Buffer.from('{"since":1}'), header, () => sender.pem, NOW), /Invalid cluster request/);
    }
  });
  assert.equal(counted.checked, 10, "the changed body is refused before any signature; the other ten were checked");
});

test("the nonce table is made sure of once per connection, and again after a rollback took it away", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jb-perf-auth-"));
  const file = path.join(directory, "receiver.db");
  let receiver = new DatabaseSync(file);
  t.after(() => { receiver.close(); rmSync(directory, { recursive: true, force: true }); });
  const sender = keyPair();
  const body = Buffer.from("{}");
  const header = () => signRequest(sender.privateKey, SENDER, RECIPIENT, "POST", "/api/cluster/v2/x", body, NOW);
  const verify = (authorization: string) => verifyClusterRequest(receiver, RECIPIENT, "POST", "/api/cluster/v2/x", body, authorization, NOW);
  const nonceTable = (): boolean => receiver.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cluster_v2_request_nonces'").get() !== undefined;
  pinClusterPublicKey(receiver, SENDER, sender.pem);

  // Made inside a transaction that is rolled back: the next request has to make it again.
  receiver.exec("BEGIN");
  assert.equal(verify(header()), SENDER);
  receiver.exec("ROLLBACK");
  assert.equal(nonceTable(), false);
  assert.equal(verify(header()), SENDER);
  assert.equal(nonceTable(), true);

  // One more request first: the tables made above changed the schema, and the next make-sure script after that runs once more.
  assert.equal(verify(header()), SENDER);
  const requests = Array.from({ length: 10 }, header);
  const counted = counting(() => requests.map(verify));
  assert.deepEqual(counted.result, requests.map(() => SENDER));
  assert.ok(counted.statements.filter((sql) => sql === "PRAGMA schema_version").length <= 10, "no schema question for the nonce table: at most the one the pinned key's table asks per request");
  assert.equal(counted.statements.filter((sql) => sql.includes("INSERT INTO cluster_v2_request_nonces")).length, 10);
  const replayed = header();
  assert.equal(verify(replayed), SENDER);
  assert.throws(() => verify(replayed), /Cluster request replayed/);

  // Another connection to the same file knows nothing yet and makes sure for itself; the nonce is still there.
  receiver.close();
  receiver = new DatabaseSync(file);
  assert.throws(() => verify(replayed), /Cluster request replayed/);
  assert.equal(verify(header()), SENDER);
});

// The machine route itself. These two tests share the node's cluster database, in this order.
const target = "/api/cluster/v2/assistant-teams/list";
const body = Buffer.from("{}");
const senderDatabase = new DatabaseSync(":memory:");
const senderId = randomUUID();

function machineRequest(authorization: string | undefined, sent: Buffer = body): Request {
  const headers: Record<string, string | undefined> = { authorization, "content-length": String(sent.length), "content-type": "application/json" };
  const request = { method: "POST", path: target.slice("/api".length), originalUrl: target, url: target, socket: {}, headers, header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
  captureClusterRawBody(request, undefined as never, sent);
  return request;
}

async function admit(request: Request): Promise<{ status: number; passed: boolean; sender?: string }> {
  const state = { status: 200, passed: false, locals: {} as Record<string, unknown> };
  const response = { locals: state.locals, status(code: number) { state.status = code; return response; }, json() { return response; } } as unknown as Response;
  await requireHttpAuth(request, response, ((error?: unknown) => { if (error) throw error; state.passed = true; }) as NextFunction);
  return { status: state.status, passed: state.passed, sender: state.locals.machineNodeId as string | undefined };
}

const identityRow = (db: DatabaseSync): unknown => db.prepare("SELECT node_id FROM cluster_v2_identity WHERE singleton = 1").get();

test("an identity made inside a transaction that is rolled back is made again by the next request", async () => {
  const db = await clusterV2Database(), node = await getClusterNode();
  pinClusterPublicKey(db, senderId, getOrCreateClusterIdentity(senderDatabase, senderId).publicKey);
  const sign = () => signClusterRequest(senderDatabase, senderId, node.id, "POST", target, body);
  assert.equal(identityRow(db), undefined, "this test must be the first to ask for the node's identity");
  db.exec("BEGIN");
  try {
    assert.deepEqual(await admit(machineRequest(sign())), { status: 200, passed: true, sender: senderId });
    assert.notEqual(identityRow(db), undefined);
  } finally { db.exec("ROLLBACK"); }
  assert.equal(identityRow(db), undefined, "rolled back with everything else the request wrote");
  assert.deepEqual(await admit(machineRequest(sign())), { status: 200, passed: true, sender: senderId });
  assert.notEqual(identityRow(db), undefined, "the check was not remembered from inside the transaction");
  assert.equal(pinnedClusterPublicKey(db, node.id), getOrCreateClusterIdentity(db, node.id).publicKey);
});

test("a machine request makes sure of this node's identity once, and checks everything else every time", async () => {
  const db = await clusterV2Database(), node = await getClusterNode();
  const sign = (sent: Buffer = body) => signClusterRequest(senderDatabase, senderId, node.id, "POST", target, sent);
  await admit(machineRequest(sign()));
  const identityReads = (statements: string[]): number => statements.filter((sql) => sql.includes("FROM cluster_v2_identity") && sql.includes("private_key_encrypted")).length;
  const pinReads = (statements: string[]): number => statements.filter((sql) => sql.includes("FROM cluster_v2_public_keys")).length;
  // Signed beforehand, so that only what the receiving side runs is counted.
  const requests = Array.from({ length: 10 }, () => machineRequest(sign()));
  const later = await countingAsync(async () => {
    for (const request of requests) assert.deepEqual(await admit(request), { status: 200, passed: true, sender: senderId });
  });
  assert.equal(identityReads(later.statements), 0, "this node's identity is not read again");
  assert.equal(pinReads(later.statements), 10, "the sender's pinned key is read for every request, and this node's own no more");
  assert.equal(later.statements.filter((sql) => sql.includes("INSERT INTO cluster_v2_request_nonces")).length, 10, "every request records its nonce");

  const replayed = sign();
  assert.equal((await admit(machineRequest(replayed))).passed, true);
  assert.deepEqual(await admit(machineRequest(replayed)), { status: 401, passed: false, sender: undefined }, "the same header a second time");
  assert.deepEqual(await admit(machineRequest(sign(), Buffer.from('{"changed":true}'))), { status: 401, passed: false, sender: undefined }, "a body other than the signed one");
  assert.deepEqual(await admit(machineRequest(undefined)), { status: 401, passed: false, sender: undefined });
  const strangerDatabase = new DatabaseSync(":memory:"), strangerId = randomUUID();
  getOrCreateClusterIdentity(strangerDatabase, strangerId);
  assert.deepEqual(await admit(machineRequest(signClusterRequest(strangerDatabase, strangerId, node.id, "POST", target, body))), { status: 401, passed: false, sender: undefined }, "a sender whose key is not pinned");
  // Signed with another key in the pinned sender's name.
  const forgerDatabase = new DatabaseSync(":memory:");
  getOrCreateClusterIdentity(forgerDatabase, senderId);
  assert.deepEqual(await admit(machineRequest(signClusterRequest(forgerDatabase, senderId, node.id, "POST", target, body))), { status: 401, passed: false, sender: undefined });
  assert.deepEqual(await admit(machineRequest(sign())), { status: 200, passed: true, sender: senderId }, "and the real sender is still let in");
  strangerDatabase.close(); forgerDatabase.close();
});
