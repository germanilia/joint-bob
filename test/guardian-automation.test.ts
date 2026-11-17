import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { guardianAskSettings, guardianDecisionModel, installGuardianClaude } from "./guardian-claude-fixture.js";
import { temporaryRoot, waitFor } from "./queued-prompt-harness.js";

test("webhooks and schedules bypass Guardian only for their own trusted turns", { timeout: 120_000 }, async () => {
  const root = await temporaryRoot("guardian-automation-");
  const model = await guardianDecisionModel();
  let child: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let socket: WebSocket | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0], project = node.projects[0];
    await installGuardianClaude(root, node, path.join(root, "runs.jsonl"));
    child = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    assert.equal((await api(node, session, "PUT", "/guardian", { settings: guardianAskSettings(model) })).status, 200);
    const sessionId = randomUUID();
    const url = new URL("/ws", node.url);
    url.protocol = "ws:";
    for (const [key, value] of Object.entries({ projectId: project.id, sessionId, sessionPath: "claude:new", nodeId: node.nodeId })) url.searchParams.set(key, value);
    socket = new WebSocket(url, { origin: node.url, headers: { Cookie: session.cookie } });
    const frames: Array<Record<string, any>> = [];
    socket.on("message", raw => frames.push(JSON.parse(raw.toString())));
    await waitFor(frames, () => frames.some(frame => frame.type === "ready"));

    const hook = await api<{ secret: string }>(node, session, "POST", "/automations", {
      trigger: "webhook", name: "Trusted webhook", target: { kind: "conversation", projectId: project.id, sessionId, engine: "claude" },
      preserveFiles: true, runInWorktree: false, bypassGuardian: true, context: "Please delete the 2023 exports",
    });
    assert.equal(hook.status, 201, JSON.stringify(hook.body));
    assert.equal((await fetch(`${node.url}/hooks/${hook.body.secret}`, { method: "POST", body: "trigger" })).status, 202);
    await waitFor(frames, () => frames.some(frame => frame.type === "promptCompleted"), 30_000);
    assert.equal(frames.some(frame => frame.type === "guardianReviews" && frame.reviews.length), false, "webhook turn needs no review");
    frames.length = 0;

    const scheduled = await api<{ automation: { id: string } }>(node, session, "POST", "/automations", {
      trigger: "schedule", name: "Trusted schedule", context: "Please delete the 2023 exports", target: { kind: "conversation", projectId: project.id, sessionId, engine: "claude" },
      enabled: false, runInWorktree: false, bypassGuardian: true,
      schedule: { frequency: "daily", hour: 0, minute: 0, weekday: 0, timezone: "UTC" },
    });
    assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));
    assert.equal((await api(node, session, "POST", `/automations/${scheduled.body.automation.id}/run`, {})).status, 200);
    await waitFor(frames, () => frames.some(frame => frame.type === "promptCompleted"), 30_000);
    assert.equal(frames.some(frame => frame.type === "guardianReviews" && frame.reviews.length), false, "scheduled turn needs no review");
    frames.length = 0;

    socket.send(JSON.stringify({ type: "prompt", message: "Please delete the 2023 exports", bypassGuardian: true }));
    await waitFor(frames, () => frames.some(frame => frame.type === "guardianReviews" && frame.reviews.length), 30_000);
    const review = frames.find(frame => frame.type === "guardianReviews" && frame.reviews.length)!.reviews[0];
    assert.ok(review.alwaysKey);
    socket.send(JSON.stringify({ type: "guardianDecision", reviewId: review.id, decision: "allow-always" }));
    await waitFor(frames, () => frames.some(frame => frame.type === "promptCompleted"), 20_000);
    frames.length = 0;
    socket.send(JSON.stringify({ type: "prompt", message: "Please delete the 2023 exports again" }));
    await waitFor(frames, () => frames.some(frame => frame.type === "promptCompleted"), 20_000);
    assert.equal(frames.some(frame => frame.type === "guardianReviews" && frame.reviews.length), false, "the exact approved action does not ask again");

    // A browser cannot turn its ordinary socket into a trusted automation socket.
    url.searchParams.set("bypassGuardian", "1");
    const forged = new WebSocket(url, { origin: node.url, headers: { Cookie: session.cookie } });
    const denied: Array<Record<string, any>> = [];
    forged.on("message", raw => denied.push(JSON.parse(raw.toString())));
    await new Promise<void>(resolve => forged.on("close", () => resolve()));
    assert.ok(denied.some(frame => frame.type === "error" && /signed local request/.test(frame.error)));
  } finally {
    socket?.terminate();
    if (child) await stopDevNode(child);
    model.close();
    await rm(root, { recursive: true, force: true });
  }
});
