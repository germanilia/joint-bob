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
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("the inbox reads past conversations and system messages, and keeps stars and folders with the account", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-inbox-"));
  const previous = { dataDir: process.env.PI_WEB_DATA_DIR, user: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD };
  let node: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = root;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const app = await import(`../src/app.js?inbox=${Date.now()}-${Math.random()}`);
    node = await listen(app.createApp());
    const login = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const { csrfToken } = await login.json() as { csrfToken: string };
    await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "a-new-long-password-123" }) });
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };

    const past = await fetch(`${node.baseUrl}/api/control-center/past`, { headers: { Cookie: cookie } });
    assert.equal(past.status, 200);
    assert.deepEqual(await past.json(), { conversations: [] });

    // A fresh node has no project, so no key for the decision model; Guardian is not set up either.
    const system = await fetch(`${node.baseUrl}/api/control-center/system`, { headers: { Cookie: cookie } });
    assert.equal(system.status, 200);
    const { messages } = await system.json() as { messages: Array<{ id: string; severity: string; steps: string[] }> };
    const ids = messages.map((message) => message.id);
    assert.ok(ids.includes("decision-model"), `the missing decision model key is reported (got ${ids.join(", ")})`);
    assert.ok(messages.every((message) => message.steps.length > 0));

    const preferences = await (await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } })).json() as { controlCenter: Record<string, unknown> };
    const saved = await fetch(`${node.baseUrl}/api/preferences`, {
      method: "PUT", headers,
      body: JSON.stringify({ controlCenter: { ...preferences.controlCenter, stars: ["claude:abc", "pi:def"], folders: { "claude:abc": "Releases", "pi:def": " Bedek " } } }),
    });
    assert.equal(saved.status, 200);
    const again = await (await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } })).json() as { controlCenter: { stars: string[]; folders: Record<string, string> } };
    assert.deepEqual(again.controlCenter.stars, ["claude:abc", "pi:def"]);
    assert.deepEqual(again.controlCenter.folders, { "claude:abc": "Releases", "pi:def": "Bedek" });

    // No automatic cleanup may delete a starred conversation: the retention sweep reads them as it reads pins.
    const { starredConversationKeys } = await import("../src/preferences.js");
    assert.deepEqual(starredConversationKeys().sort(), ["claude:abc", "pi:def"]);

    const tooMany = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ controlCenter: { ...preferences.controlCenter, stars: Array.from({ length: 501 }, (_, index) => `claude:${index}`) } }) });
    assert.equal(tooMany.status, 400, "a list of stars has a bound");
  } finally {
    await node?.close();
    for (const [name, value] of [["PI_WEB_DATA_DIR", previous.dataDir], ["MASTER_BOB_ADMIN_USERNAME", previous.user], ["MASTER_BOB_INITIAL_PASSWORD", previous.password]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
