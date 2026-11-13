import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function startNode(dataDir: string) {
  process.env.PI_WEB_DATA_DIR = dataDir;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  const { createApp } = await import(`../src/app.js?settings=${Date.now()}-${Math.random()}`);
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function authenticatedHeaders(baseUrl: string): Promise<Record<string, string>> {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "initial-password" }),
  });
  const body = await login.json() as { csrfToken: string };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing session cookie");
  const changed = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": body.csrfToken },
    body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
  });
  assert.equal(changed.status, 204);
  return { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
}

test("settings API persists runtime choices without returning secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-bob-settings-api-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  let node: Awaited<ReturnType<typeof startNode>> | undefined;
  try {
    node = await startNode(root);
    const headers = await authenticatedHeaders(node.baseUrl);
    const initialSettings = await (await fetch(`${node.baseUrl}/api/settings`, { headers })).json();
    assert.equal(initialSettings.strictResourceIsolation, true);
    assert.equal(initialSettings.newConversationWorktree, true, "new conversations default to their own worktree");
    assert.equal(initialSettings.gitPullFileLimit, 1000);
    assert.equal(initialSettings.gitPullTimeoutSeconds, 360);
    const piRuntime = { configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") };
    const claudeRuntime = { configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-sessions") };
    const defaults = await fetch(`${node.baseUrl}/api/settings/runtime-defaults`, { headers });
    assert.equal(defaults.status, 200);
    const runtimeDefaults = await defaults.json() as Record<string, { executable: string; configPath: string; sessionPath: string }>;
    const kiroRuntime = runtimeDefaults.kiro;
    // These assertions also verify an omitted harness retains all its defaults.
    function withAntigravity(expected: Record<string, any>) {
      return { ...expected, antigravity: runtimeDefaults.antigravity,
        conversationDefaults: { ...expected.conversationDefaults, antigravity: initialSettings.conversationDefaults.antigravity },
        runtimes: { ...expected.runtimes, antigravity: runtimeDefaults.antigravity },
        runtimeOverrides: { ...expected.runtimeOverrides, antigravity: { executable: "", configPath: "", sessionPath: "" } },
        restartRequired: { ...expected.restartRequired, antigravity: false },
      };
    }
    const checked = await fetch(`${node.baseUrl}/api/settings/runtime-check`, {
      method: "POST", headers,
      body: JSON.stringify({ pi: { executable: "missing-pi", configPath: path.join(root, "missing"), sessionPath: path.join(root, "missing") }, claude: { executable: "claude", configPath: "", sessionPath: "" } }),
    });
    assert.equal(checked.status, 200);
    assert.equal((await checked.json()).pi.configPath.ok, false, "missing config folder is reported");
    const backupOff = {
      destination: "off", keepDays: 30, folder: "", hasSecretAccessKey: false, defaultFolder: path.join(root, "conversation-backups"),
      s3: { bucket: "", region: "", prefix: "", endpoint: "", credentials: "keys", accessKeyId: "", profile: "" },
    };
    const conversationDefaults = {
      pi: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "low" },
      claude: { provider: "claude", modelId: "sonnet", thinkingLevel: "high" },
      kiro: { provider: "kiro", modelId: "default", thinkingLevel: "medium" },
    };
    const conversationCommands = {
      start: { enabled: true, prompt: "Pull main before work." },
      end: { enabled: true, prompt: "Commit, push, and watch CI." },
      presets: [{ name: "Review changes", prompt: "Review my changes." }],
    };
    const saved = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pi: { executable: "/usr/local/bin/pi", ...piRuntime },
        claude: { executable: "/usr/local/bin/claude", ...claudeRuntime },
        conversationDefaults,
        conversationCommands,
        newConversationWorktree: false,
        gitPullFileLimit: 750,
        conversationHistoryDays: 45,
        conversationRetentionDays: 60,
        // Two of the six boxes; the four that are left out stay off.
        conversationRetentionScope: { full: true, leftovers: true },
        projects: { homePath: path.join(root, "JointBob") },
        resources: { skills: [path.join(root, "skills"), path.join(root, "skills")], prompts: [path.join(root, "prompts")], rules: [path.join(root, "rules")], plugins: [path.join(root, "plugins")] },
      }),
    });
    assert.equal(saved.status, 200);
    const savedText = await saved.text();
    assert.doesNotMatch(savedText, /secret-api-key/);
    const presetId = JSON.parse(savedText).conversationCommands.presets[0].id;
    assert.match(presetId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "legacy presets receive a stable ID");
    Object.assign(conversationCommands.presets[0], { id: presetId });
    assert.deepEqual(JSON.parse(savedText), withAntigravity({
      kiroEnabled: true,
      strictResourceIsolation: true,
      autoActivateSharedSkills: true,
      gitPullFileLimit: 750,
      gitPullTimeoutSeconds: 360,
      subprocessMaxLifetimeMinutes: 360,
      conversationCpuLimitCores: null,
      conversationMemoryLimitGb: null,
      conversationDefaults,
      conversationHistoryDays: 45,
      conversationRetentionDays: 60,
      conversationRetentionScope: { full: true, includeUnrecorded: false, includeScheduled: false, leftovers: true, backgroundRuns: false },
      conversationBackup: backupOff,
      autoCompactThreshold: 70,
      digestAttachments: false,
      showProjectsOnOtherNodes: true,
      newConversationWorktree: false,
      syncCheck: { enabled: true, harnessId: "pi", ...conversationDefaults.pi },
      dashboards: { harnessId: "pi", ...conversationDefaults.pi },
      backgroundAgent: { harnessId: "", provider: "", modelId: "", thinkingLevel: "" },
      remoteTerminal: { twins: true, otherNodes: false },
      runnerAccess: { otherNodes: false },
      conversationCommands,
      shellCommandTimeoutSeconds: null,
      pi: { executable: "/usr/local/bin/pi", ...piRuntime },
      claude: { executable: "/usr/local/bin/claude", ...claudeRuntime },
      kiro: kiroRuntime,
      runtimes: {
        pi: { executable: "/usr/local/bin/pi", ...piRuntime },
        claude: { executable: "/usr/local/bin/claude", ...claudeRuntime },
        kiro: kiroRuntime,
      },
      runtimeOverrides: {
        pi: { executable: "/usr/local/bin/pi", ...piRuntime },
        claude: { executable: "/usr/local/bin/claude", ...claudeRuntime },
        kiro: { executable: "", configPath: "", sessionPath: "" },
      },
      projects: { homePath: path.join(root, "JointBob") },
      resources: { skills: [path.join(root, "skills")], prompts: [path.join(root, "prompts")], rules: [path.join(root, "rules")], plugins: [path.join(root, "plugins")] },
      conversationLabels: ["Research", "Bug", "Feature", "POC", "Deploy to prod", "Hotfix"],
      conversationLabelIcons: { Research: "🔬", Bug: "🐞", Feature: "✨", POC: "🧪", "Deploy to prod": "🚀", Hotfix: "🔥" },
      restartRequired: { pi: true, claude: true, kiro: false },
    }));

    const read = await fetch(`${node.baseUrl}/api/settings`, { headers });
    assert.equal(read.status, 200);
    const readText = await read.text();
    assert.doesNotMatch(readText, /secret-api-key/);
    assert.deepEqual(JSON.parse(readText), withAntigravity({
      kiroEnabled: true,
      strictResourceIsolation: true,
      autoActivateSharedSkills: true,
      gitPullFileLimit: 750,
      gitPullTimeoutSeconds: 360,
      subprocessMaxLifetimeMinutes: 360,
      conversationCpuLimitCores: null,
      conversationMemoryLimitGb: null,
      conversationDefaults,
      conversationHistoryDays: 45,
      conversationRetentionDays: 60,
      conversationRetentionScope: { full: true, includeUnrecorded: false, includeScheduled: false, leftovers: true, backgroundRuns: false },
      conversationBackup: backupOff,
      autoCompactThreshold: 70,
      digestAttachments: false,
      showProjectsOnOtherNodes: true,
      newConversationWorktree: false,
      syncCheck: { enabled: true, harnessId: "pi", ...conversationDefaults.pi },
      dashboards: { harnessId: "pi", ...conversationDefaults.pi },
      backgroundAgent: { harnessId: "", provider: "", modelId: "", thinkingLevel: "" },
      remoteTerminal: { twins: true, otherNodes: false },
      runnerAccess: { otherNodes: false },
      conversationCommands,
      shellCommandTimeoutSeconds: null,
      pi: { executable: "/usr/local/bin/pi", ...piRuntime },
      claude: { executable: "/usr/local/bin/claude", ...claudeRuntime },
      kiro: kiroRuntime,
      runtimes: {
        pi: { executable: "/usr/local/bin/pi", ...piRuntime },
        claude: { executable: "/usr/local/bin/claude", ...claudeRuntime },
        kiro: kiroRuntime,
      },
      runtimeOverrides: {
        pi: { executable: "/usr/local/bin/pi", ...piRuntime },
        claude: { executable: "/usr/local/bin/claude", ...claudeRuntime },
        kiro: { executable: "", configPath: "", sessionPath: "" },
      },
      projects: { homePath: path.join(root, "JointBob") },
      resources: { skills: [path.join(root, "skills")], prompts: [path.join(root, "prompts")], rules: [path.join(root, "rules")], plugins: [path.join(root, "plugins")] },
      conversationLabels: ["Research", "Bug", "Feature", "POC", "Deploy to prod", "Hotfix"],
      conversationLabelIcons: { Research: "🔬", Bug: "🐞", Feature: "✨", POC: "🧪", "Deploy to prod": "🚀", Hotfix: "🔥" },
      restartRequired: { pi: false, claude: false, kiro: false },
    }));

    for (const strictResourceIsolation of [false, true, "false", null]) {
      const response = await fetch(`${node.baseUrl}/api/settings`, {
        method: "PUT", headers,
        body: JSON.stringify({ strictResourceIsolation }),
      });
      assert.equal(response.status, typeof strictResourceIsolation === "boolean" ? 200 : 400);
      if (response.ok) assert.equal((await response.json()).strictResourceIsolation, strictResourceIsolation);
    }

    const preservedResources = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pi: { executable: "/usr/local/bin/pi", ...piRuntime },
        claude: { executable: "/usr/local/bin/claude", ...claudeRuntime },
        projects: { homePath: path.join(root, "JointBob") },
      }),
    });
    assert.equal(preservedResources.status, 200);
    const preserved = await preservedResources.json();
    assert.equal(preserved.conversationHistoryDays, 45);
    assert.equal(preserved.newConversationWorktree, false, "unrelated saves preserve an explicit worktree opt-out");
    assert.equal(preserved.gitPullFileLimit, 750, "omitting PR file limit preserves it");
    assert.deepEqual(preserved.conversationCommands, conversationCommands, "omitting commands preserves them");
    assert.deepEqual(preserved.resources, { skills: [path.join(root, "skills")], prompts: [path.join(root, "prompts")], rules: [path.join(root, "rules")], plugins: [path.join(root, "plugins")] });

    const project = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Resource project", path: path.join(root, "project") }) });
    const projectBody = await project.json() as { project: { id: string } };
    assert.equal(project.status, 201);
    const projectPaths = await fetch(`${node.baseUrl}/api/projects/${projectBody.project.id}/resource-paths`, {
      method: "PUT", headers,
      body: JSON.stringify({ resources: { skills: [path.join(root, "project-skills"), path.join(root, "project-skills")], prompts: [], rules: [], plugins: [] } }),
    });
    assert.equal(projectPaths.status, 200);
    assert.deepEqual(await projectPaths.json(), { resources: { skills: [path.join(root, "project-skills")], prompts: [], rules: [], plugins: [] } });
    const readProjectPaths = await fetch(`${node.baseUrl}/api/projects/${projectBody.project.id}/resource-paths`, { headers });
    assert.equal(readProjectPaths.status, 200);
    assert.deepEqual(await readProjectPaths.json(), { resources: { skills: [path.join(root, "project-skills")], prompts: [], rules: [], plugins: [] } });
    const relativeProjectResources = await fetch(`${node.baseUrl}/api/projects/${projectBody.project.id}/resource-paths`, {
      method: "PUT", headers,
      body: JSON.stringify({ resources: { skills: ["relative"], prompts: [], rules: [], plugins: [] } }),
    });
    assert.equal(relativeProjectResources.status, 400);
    const missingProjectPaths = await fetch(`${node.baseUrl}/api/projects/missing/resource-paths`, { headers });
    assert.equal(missingProjectPaths.status, 404);

    for (const limit of [0, 3001, 1.5]) {
      const invalidLimit = await fetch(`${node.baseUrl}/api/settings`, {
        method: "PUT", headers,
        body: JSON.stringify({ gitPullFileLimit: limit }),
      });
      assert.equal(invalidLimit.status, 400);
    }
    // Backups before the sweep deletes. Off at first; what is typed can be checked before it is saved; a save that is
    // incomplete or has a field the setting does not have is refused with the reason and changes nothing.
    const backupOf = async (): Promise<Record<string, any>> => (await (await fetch(`${node.baseUrl}/api/settings`, { headers })).json()).conversationBackup;
    const putBackup = (conversationBackup: unknown): Promise<Response> => fetch(`${node.baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ conversationBackup }) });
    const checkBackup = async (body: unknown): Promise<Record<string, unknown>> => {
      const checked = await fetch(`${node.baseUrl}/api/settings/conversation-backups/check`, { method: "POST", headers, body: JSON.stringify(body) });
      assert.equal(checked.status, 200);
      return await checked.json() as Record<string, unknown>;
    };
    assert.deepEqual(await backupOf(), backupOff);
    for (const refused of [{ destination: "tape" }, { keepDays: 1.5 }, { keepDays: 4000 }, { everything: true }, { s3: { secret: "x" } }, "folder"]) {
      assert.equal((await putBackup(refused)).status, 400, JSON.stringify(refused));
    }
    // A page that saves the settings it read sends back the two fields a GET adds. They are taken and ignored.
    assert.equal((await putBackup({ ...backupOff, hasSecretAccessKey: true, defaultFolder: "/elsewhere" })).status, 200);
    const wholeSettings = await (await fetch(`${node.baseUrl}/api/settings`, { headers })).json();
    assert.equal((await fetch(`${node.baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify(wholeSettings) })).status, 200, "what a GET returns can be saved as it is");
    for (const [incomplete, reason] of [[{ destination: "s3" }, /need a bucket/], [{ destination: "folder", folder: "relative" }, /absolute path/], [{ destination: "s3", s3: { bucket: "a-bucket", region: "eu-west-1" } }, /access key ID and its secret key, or a profile/]] as const) {
      const answer = await putBackup(incomplete);
      assert.equal(answer.status, 400);
      const refusal = await answer.json() as { error: string; details?: { setting?: string } };
      assert.match(refusal.error, reason);
      assert.deepEqual(refusal.details, { setting: "conversationBackup" }, "the refusal says which setting it is about");
    }
    // A folder that something else reads or moves is refused when it is saved, not found out by the next hourly check.
    for (const [unsafe, reason] of [[path.join(piRuntime.sessionPath, "backups"), /transcript folder/], [path.dirname(piRuntime.sessionPath), /transcript folder/]] as const) {
      const answer = await putBackup({ destination: "folder", folder: unsafe });
      assert.equal(answer.status, 400, unsafe);
      const refusal = await answer.json() as { error: string; details?: { setting?: string } };
      assert.match(refusal.error, reason);
      assert.deepEqual(refusal.details, { setting: "conversationBackup" });
    }
    assert.deepEqual(await backupOf(), backupOff, "refused saves changed nothing");
    const backupFolder = path.join(root, "api backups");
    assert.deepEqual(await checkBackup({}), { ok: false, message: "Choose a folder or S3 first" });
    assert.deepEqual(await checkBackup({ destination: "folder", folder: "relative" }), { ok: false, message: "The backup folder must be an absolute path" });
    assert.deepEqual(await checkBackup({ destination: "folder", folder: backupFolder }), { ok: true, where: backupFolder });
    assert.deepEqual(await backupOf(), backupOff, "a check saves nothing");
    assert.equal((await fetch(`${node.baseUrl}/api/settings/conversation-backups/check`, { method: "POST", headers, body: JSON.stringify({ everything: true }) })).status, 400);
    const backupSaved = await putBackup({ destination: "folder", folder: backupFolder, keepDays: 14, s3: { accessKeyId: "AKIAAPITESTKEY", secretAccessKey: "a secret the API never returns" } });
    assert.equal(backupSaved.status, 200);
    const backupSavedText = await backupSaved.text();
    assert.equal(backupSavedText.includes("a secret the API never returns"), false);
    const folderBackup = { ...backupOff, destination: "folder", folder: backupFolder, keepDays: 14, hasSecretAccessKey: true, s3: { ...backupOff.s3, accessKeyId: "AKIAAPITESTKEY" } };
    assert.deepEqual(JSON.parse(backupSavedText).conversationBackup, folderBackup);
    assert.equal((await (await fetch(`${node.baseUrl}/api/settings`, { headers })).text()).includes("a secret the API never returns"), false);
    const backupStatus = { destination: "folder", where: backupFolder, keepDays: 14, kept: { backups: 0, bytes: 0 }, nextRemovalAt: null, problem: null };
    assert.deepEqual(await (await fetch(`${node.baseUrl}/api/settings/conversation-backups`, { headers })).json(), backupStatus);
    assert.deepEqual((await (await fetch(`${node.baseUrl}/api/settings/retention-preview`, { headers })).json() as { backup: unknown }).backup, backupStatus, "the dry run says where backups go");
    // A save that leaves the setting out keeps it; turning it off keeps what was typed for the next time.
    assert.equal((await fetch(`${node.baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ gitPullFileLimit: 750 }) })).status, 200);
    assert.deepEqual(await backupOf(), folderBackup);
    assert.equal((await putBackup({ destination: "off", keepDays: 30, folder: "", s3: { accessKeyId: "" } })).status, 200);
    assert.deepEqual(await backupOf(), { ...backupOff, hasSecretAccessKey: true });
    // Only the node's admin sees these routes: without a session they answer like any other route does.
    for (const [method, route] of [["GET", "/api/settings/conversation-backups"], ["POST", "/api/settings/conversation-backups/check"]] as const) {
      assert.equal((await fetch(`${node.baseUrl}${route}`, { method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) })).status, 401);
    }

    // The retention boxes: one the setting does not have, or a value that is no yes or no, is refused and changes nothing.
    for (const scope of [{ everything: true }, { full: "yes" }, true]) {
      const refusedScope = await fetch(`${node.baseUrl}/api/settings`, {
        method: "PUT", headers,
        body: JSON.stringify({ conversationRetentionScope: scope }),
      });
      assert.equal(refusedScope.status, 400);
    }
    const scopeKept = await (await fetch(`${node.baseUrl}/api/settings`, { headers })).json() as { conversationRetentionScope: Record<string, boolean> };
    assert.deepEqual(scopeKept.conversationRetentionScope, { full: true, includeUnrecorded: false, includeScheduled: false, leftovers: true, backgroundRuns: false }, "saves that left the boxes out kept them");
    for (const timeout of [59, 3601, 90.5]) {
      const invalidTimeout = await fetch(`${node.baseUrl}/api/settings`, {
        method: "PUT", headers,
        body: JSON.stringify({ gitPullTimeoutSeconds: timeout }),
      });
      assert.equal(invalidTimeout.status, 400);
    }
    const timeoutSaved = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT", headers,
      body: JSON.stringify({ gitPullTimeoutSeconds: 600 }),
    });
    assert.equal(timeoutSaved.status, 200);
    assert.equal((await (await fetch(`${node.baseUrl}/api/settings`, { headers })).json()).gitPullTimeoutSeconds, 600);

    // An older page still sends the removed Syncthing fields: the save succeeds and stores none of them.
    const { legacySyncthingConnection } = await import("../src/settings.js");
    const { save, settingsDatabase } = await import("../src/settings-store.js");
    assert.deepEqual(legacySyncthingConnection(), {}, "a node that never used Syncthing has no stored connection");
    const withRemovedKey = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT", headers,
      body: JSON.stringify({ syncthing: { endpoint: "https://not-local.example", apiKey: "must-not-store" }, gitPullTimeoutSeconds: 601 }),
    });
    assert.equal(withRemovedKey.status, 200, await withRemovedKey.clone().text());
    const afterRemovedKey = await withRemovedKey.json() as Record<string, unknown>;
    assert.equal(afterRemovedKey.gitPullTimeoutSeconds, 601, "the rest of the body is saved");
    assert.equal("syncthing" in afterRemovedKey, false);
    assert.deepEqual(legacySyncthingConnection(), {});

    // What an older release stored stays readable for taking Joint Bob's folders out of Syncthing, and is never returned.
    save(settingsDatabase(), "syncthing.endpoint", "http://127.0.0.1:8384");
    assert.deepEqual(legacySyncthingConnection(), { endpoint: "http://127.0.0.1:8384" });
    save(settingsDatabase(), "syncthing.apiKey", "stored-api-key", true);
    assert.deepEqual(legacySyncthingConnection(), { endpoint: "http://127.0.0.1:8384", apiKey: "stored-api-key" });
    const withOldRows = await (await fetch(`${node.baseUrl}/api/settings`, { headers })).text();
    assert.doesNotMatch(withOldRows, /syncthing|stored-api-key|8384/i);
    const savedOverOldRows = await fetch(`${node.baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ gitPullTimeoutSeconds: 600 }) });
    assert.equal(savedOverOldRows.status, 200);
    assert.deepEqual(legacySyncthingConnection(), { endpoint: "http://127.0.0.1:8384", apiKey: "stored-api-key" }, "a later save leaves the old rows for the retirement to read");

    const relativeResources = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT", headers,
      body: JSON.stringify({ pi: { executable: "", configPath: "", sessionPath: "" }, claude: { executable: "", configPath: "", sessionPath: "" }, projects: { homePath: path.join(root, "JointBob") }, resources: { skills: ["relative"], prompts: [], rules: [], plugins: [] } }),
    });
    assert.equal(relativeResources.status, 400);

    const relativeHomeFolder = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pi: { executable: "", configPath: "", sessionPath: "" },
        claude: { executable: "", configPath: "", sessionPath: "" },
        projects: { homePath: "relative" },
      }),
    });
    assert.equal(relativeHomeFolder.status, 400);
    assert.deepEqual(await relativeHomeFolder.json(), { error: "Joint Bob home folder must be absolute" });

    const overlappingSessions = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT", headers,
      body: JSON.stringify({ pi: { executable: "", configPath: "", sessionPath: path.join(root, "sessions") }, claude: { executable: "", configPath: "", sessionPath: path.join(root, "sessions", "claude") } }),
    });
    assert.equal(overlappingSessions.status, 400);
    assert.match((await overlappingSessions.json() as { error: string }).error, /must not overlap/);
  } finally {
    if (node) await node.close();
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME;
    else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD;
    else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(root, { recursive: true, force: true });
  }
});
