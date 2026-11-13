import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openNodeDatabase } from "../src/node-database.js";

function openSettings(dataDir: string, disable: boolean) {
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { getSettings, updateSettings } from ${JSON.stringify(new URL("../src/settings.ts", import.meta.url).href)};
    const onOpen = getSettings().newConversationWorktree;
    if (${disable}) updateSettings({ newConversationWorktree: false });
    const settings = getSettings();
    console.log(JSON.stringify({ onOpen, enabled: settings.newConversationWorktree, gitPullFileLimit: settings.gitPullFileLimit }));
  `], { env: { ...process.env, PI_WEB_DATA_DIR: dataDir }, encoding: "utf8", timeout: 30_000 });
  return JSON.parse(output.trim().split("\n").at(-1)!) as { onOpen: boolean; enabled: boolean; gitPullFileLimit: number };
}

for (const previous of [undefined, "false", "true"]) {
  test(`a node with worktrees ${previous ?? "unset"} enables them on upgrade, but keeps a later opt-out after restart`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-worktree-migration-"));
    try {
      const db = openNodeDatabase(path.join(root, "node.db"));
      db.exec("CREATE TABLE node_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, is_secret INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)");
      const seed = db.prepare("INSERT INTO node_settings (key, value, updated_at) VALUES (?, ?, ?)");
      seed.run("gitPullFileLimit", "750", "before-upgrade");
      if (previous !== undefined) seed.run("newConversationWorktree", previous, "before-upgrade");
      db.close();

      assert.deepEqual(openSettings(root, true), { onOpen: true, enabled: false, gitPullFileLimit: 750 });
      assert.deepEqual(openSettings(root, false), { onOpen: false, enabled: false, gitPullFileLimit: 750 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
