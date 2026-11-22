import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sessionListingChanged } from "../src/session-listing-revisions.js";

// A page polls its project's conversations every two seconds while something runs. Each poll
// rebuilt the whole list (22 a minute at about a second each on the Mac, 2026-11-22). A poll now
// sends the version it holds and is told "unchanged" until the project's list is marked changed.
test("a poll with the list's version is answered unchanged until the project's list changes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-open-list-poll-"));
  const previous = { dataDir: process.env.PI_WEB_DATA_DIR, username: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD };
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  const { createApp } = await import(`../src/app.js?open-list-poll=${Date.now()}`);
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
  const folder = path.join(root, "Polled");
  await mkdir(folder);
  const created = await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Polled", path: folder, synced: false }) });
  assert.equal(created.status, 201);
  const projectId = (await created.json() as { project: { id: string } }).project.id;
  const list = async (since?: string) => {
    const response = await fetch(`${base}/api/projects/${projectId}/sessions${since ? `?since=${encodeURIComponent(since)}` : ""}`, { headers });
    assert.equal(response.status, 200);
    return await response.json() as { sessions?: unknown[]; revision?: string; unchanged?: boolean };
  };

  const first = await list();
  assert.ok(Array.isArray(first.sessions), "an ordinary request gets the list");
  assert.equal(typeof first.revision, "string", "with the version a poll sends back");
  const polled = await list(first.revision);
  // The version also turns over every 15 s; a test that crosses that boundary gets the list again.
  if (polled.unchanged) {
    assert.equal(polled.sessions, undefined, "nothing changed: no list is built or sent");
    assert.equal(polled.revision, first.revision);
  } else assert.ok(Array.isArray(polled.sessions));

  sessionListingChanged(projectId);
  const changed = await list(first.revision);
  assert.ok(Array.isArray(changed.sessions), "a change marked for the project brings the whole list");
  assert.notEqual(changed.revision, first.revision);
  assert.ok(Array.isArray((await list("some other version")).sessions), "a version the server does not hold gets the list");
  sessionListingChanged("another-project");
  const other = await list(changed.revision);
  if (other.unchanged === undefined) assert.ok(Array.isArray(other.sessions)); // crossed the 15 s boundary
  else assert.equal(other.unchanged, true, "another project's change leaves this list alone");
});
