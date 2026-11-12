import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAgentDir } from "../src/pi-sdk.js";
import { getClusterNode } from "../src/cluster.js";
import { runAsAccount } from "../src/account-context.js";
import { addProject } from "../src/store.js";
import { setResourceOwner } from "../src/ownership.js";
import { createProviderProfile } from "../src/provider-profiles/store.js";
import { openAIAuthPath } from "../src/provider-profiles/service.js";
import { createSubscriptionPool, setSubscriptionPoolChoice } from "../src/provider-profiles/pools.js";

// A native login must neither be refreshed nor consulted, even before a pool member is pinned.
test("pooled Pi startup ignores expired native OAuth and uses only its app profile", async context => {
  await getClusterNode();
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-app-only-"));
  const nativePath = path.join(getAgentDir(), "auth.json");
  await mkdir(path.dirname(nativePath), { recursive: true });
  const native = JSON.stringify({ "openai-codex": { type: "oauth", access: "fixture-expired", refresh: "fixture-reused", expires: 1 } });
  await writeFile(nativePath, native);
  const requests: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests.push(new URL(typeof input === "string" || input instanceof URL ? input : input.url).origin);
    throw new Error("Native OAuth must never be refreshed");
  });
  const actor = { accountId: "app-auth-only", username: "fixture", role: "admin" as const, isRemoteLogin: false, homeNodeId: null };
  const oldKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "fixture-ambient-key";
  try {
    const project = await addProject("App auth only", root, { writeInstructions: false });
    setResourceOwner("project", project.id, actor.accountId);
    const profile = createProviderProfile(actor.accountId, { label: "App Pi", provider: "pi" });
    await mkdir(path.dirname(openAIAuthPath(profile)), { recursive: true });
    await writeFile(openAIAuthPath(profile), JSON.stringify({ zai: { type: "api_key", key: "fixture-app-key" } }));
    const pool = createSubscriptionPool(actor.accountId, { name: "App pool", profileIds: [profile.id] });
    setSubscriptionPoolChoice(actor.accountId, { scope: "project", scopeId: project.id, poolId: pool.id });
    const { createPiSession, listAvailableModels } = await import("../src/pi-service.js");
    await runAsAccount(actor, async () => {
      const available = await listAvailableModels();
      assert.equal(available.some(model => model.provider === "openai-codex"), false);
      assert.equal(available.some(model => model.provider === "google"), false);
      assert.ok(available.some(model => model.provider === "zai"));
      const handle = await createPiSession({ projectId: project.id, cwd: root, sessionId: "app-only-session" });
      try {
        assert.equal(await handle.session.modelRuntime.getAuth("openai-codex"), undefined);
        assert.equal(await handle.session.modelRuntime.getAuth("google"), undefined);
        // Pin the app profile just as pool execution does for each attempt.
        const { withPoolProfile } = await import("../src/provider-profiles/context.js");
        await withPoolProfile({ profileId: profile.id, profile, provider: "pi", poolId: pool.id, label: profile.label }, () => handle.withModelProfile!("zai", async () => {
          assert.equal((await handle.session.modelRuntime.getAuth("zai"))?.auth.apiKey, "fixture-app-key");
        }));
      } finally { handle.dispose(); }
    });
    assert.deepEqual(requests.filter(origin => new URL(origin).hostname !== "127.0.0.1"), [], "opening or listing pooled Pi models must not refresh native OAuth");
    assert.equal(await readFile(nativePath, "utf8"), native);
  } finally {
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
    await rm(nativePath, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
