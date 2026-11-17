import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

const schedule = { frequency: "daily", hour: 9, minute: 15, weekday: 1, timezone: "UTC" };
type Item = { id: string; name: string; trigger: "webhook" | "schedule"; nextRun: number | null; enabled: boolean; lastRun: unknown; lastDelivery: unknown; context: string; ownerNodeId: string | null; hideFromHistory: boolean };

test("one automation is created, run, switched between a schedule and a webhook, given context and deleted through one API", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automations-api-"));
  let child: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    child = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    const projectId = node.projects[0].id;
    const target = { kind: "project", projectId, engine: "claude" };

    // A scheduled automation has no address and a next run.
    const created = await api<{ automation: Item; secret: string | null; bases: unknown[] }>(node, session, "POST", "/automations", { name: "Nightly check [date]", target, context: "Check the build", trigger: "schedule", schedule });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.secret, null);
    assert.equal(created.body.automation.trigger, "schedule");
    assert.equal(created.body.automation.ownerNodeId, node.nodeId);
    assert.ok((created.body.automation.nextRun ?? 0) > Date.now());
    const id = created.body.automation.id;

    // A webhook automation has an address, shown once.
    const hook = await api<{ automation: Item; secret: string }>(node, session, "POST", "/automations", { name: "GitHub issues", target, context: "Triage it", trigger: "webhook" });
    assert.equal(hook.status, 201, JSON.stringify(hook.body));
    assert.match(hook.body.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(hook.body.automation.nextRun, null);
    assert.equal((await fetch(`${node.url}/hooks/${hook.body.secret}`, { method: "POST", body: "{}" })).status, 202, "the webhook accepts a call");
    assert.equal((await fetch(`${node.url}/hooks/${"x".repeat(43)}`, { method: "POST", body: "{}" })).status, 404);

    // One list holds both.
    const listed = await api<{ automations: Item[] }>(node, session, "GET", "/automations");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.automations.map(item => item.trigger).sort(), ["schedule", "webhook"]);

    // A scheduled automation can have files, which a schedule could not before.
    const file = await api<{ resource: { id: string; name: string } }>(node, session, "POST", `/automations/${id}/resources`, { kind: "file", name: "customers.csv", description: "Customer list", mimeType: "text/csv", data: Buffer.from("id,name\n1,Acme\n").toString("base64") });
    assert.equal(file.status, 201, JSON.stringify(file.body));
    const files = await api<{ resources: Array<{ name: string }> }>(node, session, "GET", `/automations/${id}/resources`);
    assert.deepEqual(files.body.resources.map(item => item.name), ["customers.csv"]);
    assert.equal((await api(node, session, "POST", `/automations/${id}/memory`, { action: "enable", enabled: true })).status, 200);

    // Saving other settings keeps the next run; "Run now" brings it forward.
    const renamed = await api<{ automation: Item }>(node, session, "PUT", `/automations/${id}`, { name: "Nightly build check", target, context: "Check the build", trigger: "schedule", schedule });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.automation.nextRun, created.body.automation.nextRun);
    const ran = await api<{ automation: Item }>(node, session, "POST", `/automations/${id}/run`, {});
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    const history = await api<{ calls: unknown[]; runs: unknown[] }>(node, session, "GET", `/automations/${id}/history`);
    assert.equal(history.status, 200);
    assert.ok(Array.isArray(history.body.runs) && Array.isArray(history.body.calls));

    // Switching the trigger of the webhook: its old address stops working, and a way back makes a new one.
    const toSchedule = await api<{ automation: Item; secret: string | null }>(node, session, "PUT", `/automations/${hook.body.automation.id}`, { name: "GitHub issues", target, context: "Triage it", trigger: "schedule", schedule });
    assert.equal(toSchedule.status, 200, JSON.stringify(toSchedule.body));
    assert.equal(toSchedule.body.secret, null);
    assert.equal((await fetch(`${node.url}/hooks/${hook.body.secret}`, { method: "POST", body: "{}" })).status, 404, "the address of a scheduled automation is gone");
    const regenerate = await api(node, session, "POST", `/automations/${hook.body.automation.id}/regenerate`, {});
    assert.equal(regenerate.status, 409, "a scheduled automation has no address to replace");
    const back = await api<{ automation: Item; secret: string }>(node, session, "PUT", `/automations/${hook.body.automation.id}`, { name: "GitHub issues", target, context: "Triage it", trigger: "webhook" });
    assert.match(back.body.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(back.body.secret, hook.body.secret);

    // A schedule needs instructions and a schedule; a webhook has none.
    assert.equal((await api(node, session, "POST", "/automations", { name: "No schedule", target, context: "x", trigger: "schedule" })).status, 400);
    assert.equal((await api(node, session, "POST", "/automations", { name: "Webhook with a schedule", target, context: "x", trigger: "webhook", schedule })).status, 400);

    // The history list asks which scheduled automations hide their conversations.
    const hidden = await api<{ automations: Array<{ id: string; hideFromHistory: boolean }> }>(node, session, "GET", `/projects/${projectId}/automations`);
    assert.equal(hidden.status, 200);
    assert.ok(hidden.body.automations.some(item => item.id === id && item.hideFromHistory === false));

    // Deleting removes it from the list. (The scheduled one may be running, which holds back its deletion.)
    const doomed = hook.body.automation.id;
    const deleted = await fetch(`${node.url}/api/automations/${doomed}`, { method: "DELETE", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken } });
    assert.equal(deleted.status, 204);
    const after = await api<{ automations: Item[] }>(node, session, "GET", "/automations");
    assert.ok(!after.body.automations.some(item => item.id === doomed));
    assert.ok(after.body.automations.some(item => item.id === id));
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
