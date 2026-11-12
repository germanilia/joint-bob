import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Express } from "express";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function listen(app: Express) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

// The workspace's left column reads the control center's board for its three groups. Opening the control center
// is how Bob learns whom to tell about later events; a glance at the left column must not sign the person up.
test("reading the board with look=1 does not make the person one Bob looks after; opening it does", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-board-look-"));
  const previous = { dataDir: process.env.PI_WEB_DATA_DIR, user: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD };
  let node: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = root;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const app = await import(`../src/app.js?board-look=${Date.now()}-${Math.random()}`);
    const { bobDatabase, listBobAccounts } = await import("../src/control-center/bob-store.js");
    node = await listen(app.createApp());
    const login = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const { csrfToken } = await login.json() as { csrfToken: string };
    const changed = await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "a-new-long-password-123" }) });
    assert.equal(changed.status, 204);

    const glance = await fetch(`${node.baseUrl}/api/control-center/board?look=1`, { headers: { Cookie: cookie } });
    assert.equal(glance.status, 200);
    assert.deepEqual(await glance.json(), { cards: [], projects: [] }, "the same board as the control center reads");
    assert.equal(listBobAccounts(await bobDatabase()).length, 0, "a glance does not sign the person up with Bob");

    const opened = await fetch(`${node.baseUrl}/api/control-center/board`, { headers: { Cookie: cookie } });
    assert.equal(opened.status, 200);
    assert.equal(listBobAccounts(await bobDatabase()).length, 1, "opening the control center does");
  } finally {
    await node?.close();
    if (previous.dataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous.dataDir;
    if (previous.user === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME; else process.env.MASTER_BOB_ADMIN_USERNAME = previous.user;
    if (previous.password === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD; else process.env.MASTER_BOB_INITIAL_PASSWORD = previous.password;
    await rm(root, { recursive: true, force: true });
  }
});
