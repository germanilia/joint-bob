import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("a signed-out Claude preflight names the expired sign-in instead of a failed command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-preflight-signed-out-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const projectCwd = path.join(root, "project");
    await mkdir(projectCwd, { recursive: true });
    const executable = path.join(root, "claude-fixture.mjs");
    const statusFile = path.join(root, "status.json");
    // Like the real CLI: the status goes to stdout, and a signed-out status exits 1.
    await writeFile(executable, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const status = JSON.parse(readFileSync(${JSON.stringify(statusFile)}, "utf8"));
if (status.raw) { process.stderr.write(status.raw); process.exit(2); }
console.log(JSON.stringify(status, null, 2));
process.exit(status.loggedIn ? 0 : 1);
`, { mode: 0o755 });
    const settings = await import(`../src/settings.js?preflight=${Date.now()}`);
    settings.updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable, configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-sessions") },
    });
    const { preflightQueuedClaude } = await import("../src/queued-preflight.js");

    await writeFile(statusFile, JSON.stringify({ loggedIn: false, authMethod: "none", loginEnded: "time_limit" }));
    await assert.rejects(preflightQueuedClaude(projectCwd, {}), (error: Error) => {
      assert.doesNotMatch(error.message, /Command failed/);
      assert.match(error.message, /Claude is signed out on .+ machine's own sign-in/);
      assert.match(error.message, /time limit/);
      assert.match(error.message, /claude auth login/);
      assert.match(error.message, /Settings → Profiles/);
      return true;
    });

    await writeFile(statusFile, JSON.stringify({ loggedIn: false, authMethod: "none" }));
    await assert.rejects(preflightQueuedClaude(projectCwd, {}), (error: Error) => !/time limit/.test(error.message) && /signed out/.test(error.message));

    await writeFile(statusFile, JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
    await preflightQueuedClaude(projectCwd, {});

    // A crash without a status is still reported as the failure it is.
    await writeFile(statusFile, JSON.stringify({ raw: "boom" }));
    await assert.rejects(preflightQueuedClaude(projectCwd, {}), /Command failed/);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
