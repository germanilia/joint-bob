import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { announceGuardianWarning } from "../src/guardian/reviews.js";
import { projectListingRevision } from "../src/session-listing-revisions.js";

// Opening a conversation makes it a recent. That used to mark every project's kept list
// changed, so each open rebuilt every project's list on the next board read of every page
// (300-540 builds a minute on the Mac, 2026-11-21). A recent or a pin changes its own project. Opening one also takes
// control of it, renewed every 20 s, and that marked every list too; the board reads leases and Guardian steps live.
test("a recent or a pin marks only its own project's list, a control lease or a Guardian step none", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-recents-scope-"));
  const previous = { dataDir: process.env.PI_WEB_DATA_DIR, username: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD };
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  const { createApp } = await import(`../src/app.js?recents-scope=${Date.now()}`);
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of [["PI_WEB_DATA_DIR", previous.dataDir], ["MASTER_BOB_ADMIN_USERNAME", previous.username], ["MASTER_BOB_INITIAL_PASSWORD", previous.password]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  const base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
  const { csrfToken } = await login.json() as { csrfToken: string };
  const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
  assert.equal((await fetch(`${base}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) })).status, 204);
  const project = async (name: string) => {
    const folder = path.join(root, name);
    await mkdir(folder);
    const response = await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name, path: folder, synced: false }) });
    assert.equal(response.status, 201);
    return (await response.json() as { project: { id: string } }).project.id;
  };
  const opened = await project("Opened");
  const other = await project("Other");

  const before = { opened: projectListingRevision(opened), other: projectListingRevision(other) };
  const now = new Date().toISOString();
  const sessionId = "3f0e9a52-8a5e-4c43-9a51-0b0f7f1b6c11";
  const recent = await fetch(`${base}/api/recents`, { method: "PUT", headers, body: JSON.stringify({ projectId: opened, engine: "claude", sessionId, sessionPath: `claude:/tmp/${sessionId}.jsonl`, title: "Opened conversation", openedAt: now, updatedAt: now }) });
  assert.equal(recent.status, 200);
  assert.notEqual(projectListingRevision(opened), before.opened, "the opened conversation's project lists it again");
  assert.equal(projectListingRevision(other), before.other, "every other project keeps its list");

  const afterRecent = { opened: projectListingRevision(opened), other: projectListingRevision(other) };
  assert.equal((await fetch(`${base}/api/recents`, { method: "DELETE", headers, body: JSON.stringify({ projectId: opened, engine: "claude", sessionId }) })).status, 200);
  assert.notEqual(projectListingRevision(opened), afterRecent.opened);
  assert.equal(projectListingRevision(other), afterRecent.other, "removing a recent leaves other projects too");

  const afterRemoval = { opened: projectListingRevision(opened), other: projectListingRevision(other) };
  assert.equal((await fetch(`${base}/api/pins`, { method: "PUT", headers, body: JSON.stringify({ kind: "project", projectId: opened, pinned: true }) })).status, 200);
  assert.notEqual(projectListingRevision(opened), afterRemoval.opened);
  assert.equal(projectListingRevision(other), afterRemoval.other, "a pin leaves other projects too");

  const beforeLease = { opened: projectListingRevision(opened), other: projectListingRevision(other) };
  const lease = (action: string) => fetch(`${base}/api/control-center/lease`, { method: "POST", headers, body: JSON.stringify({ projectId: opened, conversationId: sessionId, action }) });
  for (const action of ["take", "take", "release"]) assert.equal((await lease(action)).status, 200, `lease ${action}`);
  announceGuardianWarning(opened, sessionId, "Guardian looked at a command");
  assert.deepEqual({ opened: projectListingRevision(opened), other: projectListingRevision(other) }, beforeLease, "taking, renewing and giving back control, and a Guardian step, mark no project's list changed");
});
