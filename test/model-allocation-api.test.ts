import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("allocation preview is authenticated, recommendation-only and cannot import foreign history", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-allocation-api-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const child = await startDevNode(environment, node);
  try {
    assert.equal((await fetch(`${node.url}/api/routing-configs/allocation`)).status, 401);
    const auth = await signIn(environment, node);
    const status = await api<any>(node, auth, "GET", "/routing-configs/allocation");
    assert.equal(status.status, 200); assert.equal(status.body.mode, "recommendation-only");
    const identity = { provider: "fixture", modelId: "model", release: "1", harness: "pi", scaffold: "1", reasoning: "high" };
    const body = { assessment: { taskId: "task", domain: "software-repair", complexity: 4, risk: "low", capabilities: [], classifier: "fixture", confidence: 0.9 }, baseline: identity, pinned: true, candidates: [], evidence: [] };
    const preview = await api<any>(node, auth, "POST", "/routing-configs/allocation/preview", body);
    assert.equal(preview.status, 200); assert.equal(preview.body.recommended, null); assert.match(preview.body.reason, /Manual/);
    const disabled = await api<any>(node, auth, "GET", "/routing-configs/allocation/policy");
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.policy.mode, "off");
    const policy = { mode: "recommendation", candidates: [], evidence: [], recoveryAllowance: 0, acceptedValidation: false };
    assert.equal((await api(node, auth, "PUT", "/routing-configs/allocation/policy", policy)).status, 200);
    assert.equal((await api<any>(node, auth, "GET", "/routing-configs/allocation/policy")).body.policy.mode, "recommendation");
    assert.equal((await api(node, auth, "PUT", "/routing-configs/allocation/policy", { ...policy, mode: "automatic", acceptedValidation: true })).status, 409);
    assert.equal((await api(node, auth, "POST", "/routing-configs/allocation/preview", { ...body, outcomes: [] })).status, 400);
    assert.equal((await api(node, auth, "POST", "/routing-configs/allocation/preview", { ...body, authorizedProjectIds: ["foreign"] })).status, 400);
  } finally { await stopDevNode(child); await rm(root, { recursive: true, force: true }); }
});
