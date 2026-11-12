import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** A CLI that stays alive after its answer, waiting on its own background task, says the answer is out. */
test("runClaudePrompt reports the answer before the process ends", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-answered-"));
  const previousDataDir = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  try {
    const fakeClaude = path.join(root, "claude-fake");
    await writeFile(fakeClaude, [
      "#!/bin/sh",
      "cat >/dev/null",
      `echo '{"type":"system","subtype":"init","session_id":"33333333-3333-4333-8333-333333333333","tools":["Bash"]}'`,
      `echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Watcher armed. Over to you."}]}}'`,
      `echo '{"type":"result","subtype":"success","is_error":false,"result":"Watcher armed. Over to you."}'`,
      "sleep 1",
      "",
    ].join("\n"), "utf8");
    await chmod(fakeClaude, 0o755);

    const settings = await import(`../src/settings.ts?claude-answered=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      projects: { homePath: path.join(root, "home") },
      claude: { executable: fakeClaude, configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
    });
    const { runClaudePrompt } = await import(`../src/claude-service.ts?claude-answered=${Date.now()}-${Math.random()}`);

    let closed = false;
    let answeredWhileAlive: boolean | undefined;
    const run = runClaudePrompt({ cwd: root, projectId: "answered-project", prompt: "hello", onEvent: (event: { type: string }) => {
      if (event.type === "turnAnswered") answeredWhileAlive = !closed;
    } });
    const result = await run.done;
    closed = true;

    assert.equal(result.ok, true);
    assert.equal(answeredWhileAlive, true, "the answer is reported while the process still runs");
  } finally {
    if (previousDataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
