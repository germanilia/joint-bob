import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openNodeDatabase } from "../src/node-database.js";

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0];
}

test("runtime audit events are redacted, local, and session-admin readable", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-audit-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = dataDir;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const { createApp } = await import(`../src/app.js?audit=${Date.now()}`);
    const cluster = await import(`../src/cluster.js?audit=${Date.now()}`);
    const secrets = await import(`../src/secrets.js?audit=${Date.now()}`);
    const secretReplication = await import(`../src/secret-replication.js?audit=${Date.now()}`);
    // Imported after PI_WEB_DATA_DIR is set: it loads the secret-key module, which binds its data directory at load.
    const { signClusterRequest } = await import("../src/cluster-protocol.js");
    const { getOrCreateClusterIdentity } = await import("../src/cluster-identity.js");
    const { appendAuditEvent, ensureAuditSchema, listAuditEvents } = await import(`../src/audit.js?audit=${Date.now()}`);
    server = createServer(createApp());
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    assert.equal((await fetch(`${baseUrl}/api/audit`)).status, 401);
    const failedLogin = () => fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "unknown", password: "wrong-password" }),
    });
    assert.equal((await failedLogin()).status, 401);
    for (let index = 0; index < 4; index += 1) assert.equal((await failedLogin()).status, 401);
    assert.equal((await failedLogin()).status, 401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as { csrfToken: string };
    const cookie = sessionCookie(login);
    const headers = { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken };
    const password = "replacement-audit-password";
    assert.equal((await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: password }),
    })).status, 204);
    assert.equal((await fetch(`${baseUrl}/api/settings`, {
      method: "PUT", headers, body: JSON.stringify({
        pi: { executable: "pi", configPath: "/tmp/pi", sessionPath: "/tmp/pi-sessions" },
        claude: { executable: "claude", configPath: "/tmp/claude", sessionPath: "/tmp/claude-sessions" },
      }),
    })).status, 200);
    await secrets.saveSecretAccount({ label: "Personal", provider: "github", replicate: true, variables: [{ name: "GH_TOKEN", kind: "value", value: "fake-github-token" }] });

    const local = await cluster.getClusterNode();
    const peerId = randomUUID();
    await secretReplication.enqueueSecretCredentialSync([peerId]);

    const audit = await fetch(`${baseUrl}/api/audit?limit=200`, { headers: { Cookie: cookie } });
    assert.equal(audit.status, 200);
    const events = (await audit.json() as { events: Array<{ eventType: string }> }).events;
    const eventTypes = new Set(events.map((event) => event.eventType));
    for (const eventType of ["auth.login.failed", "auth.login.rate_limited", "auth.login.succeeded", "auth.password.changed", "settings.updated", "secrets.credentials.sync"]) assert.ok(eventTypes.has(eventType), eventType);
    // A signed machine request is valid only on /api/cluster/v2 routes; it never reads the audit log.
    const signingDb = openNodeDatabase(path.join(dataDir, "node.db"));
    getOrCreateClusterIdentity(signingDb, local.id);
    const machineAuthorization = signClusterRequest(signingDb, local.id, local.id, "GET", "/api/audit", Buffer.alloc(0));
    signingDb.close();
    assert.equal((await fetch(`${baseUrl}/api/audit`, { headers: { Authorization: machineAuthorization } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken } })).status, 204);

    const rawAudit = JSON.stringify(await listAuditEvents(200));
    const db = openNodeDatabase(path.join(dataDir, "node.db"));
    ensureAuditSchema(db);
    assert.throws(() => appendAuditEvent(db, { eventType: "bad", actorType: "system", entityType: "test", details: { password: "forbidden" } }), /forbidden key/);
    const rawRows = JSON.stringify(db.prepare("SELECT * FROM audit_events").all());
    const credentialPayloads = JSON.stringify(db.prepare("SELECT payload_encrypted FROM secret_credential_events").all());
    for (const secret of ["initial-password", password, "fake-github-token", loginBody.csrfToken]) {
      assert.doesNotMatch(rawAudit, new RegExp(secret));
      assert.doesNotMatch(rawRows, new RegExp(secret));
      assert.doesNotMatch(credentialPayloads, new RegExp(secret));
    }
    const rawDatabase = (await readFile(path.join(dataDir, "node.db"))).toString("utf8");
    const rawWal = (await readFile(path.join(dataDir, "node.db-wal"))).toString("utf8");
    for (const secret of ["fake-github-token"]) {
      assert.doesNotMatch(rawDatabase, new RegExp(secret));
      assert.doesNotMatch(rawWal, new RegExp(secret));
    }
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME; else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD; else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(dataDir, { recursive: true, force: true });
  }
});
