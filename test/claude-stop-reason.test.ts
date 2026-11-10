import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getHarnessRuntime } from "../src/harnesses.js";
import type { HarnessEvent } from "../src/harnesses/runtime.js";
import { updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";
import { runClaudeConversationPrompt } from "../src/claude-service.js";

test("Claude rechecks permission to start after asynchronous conversation setup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-start-check-"));
  const executable = path.join(root, "claude-fake");
  await writeFile(executable, "#!/bin/sh\ncat >/dev/null\necho '{\"type\":\"result\",\"is_error\":false}'\n");
  await chmod(executable, 0o755);
  updateSettings({ claude: { executable, configPath: path.join(root, "config"), sessionPath: path.join(root, "sessions") }, syncthing: { endpoint: "" } });
  const project = await addProject(`start-check-${Date.now()}`, path.join(root, "project"), { writeInstructions: false });
  const result = await runClaudeConversationPrompt({
    cwd: project.path, projectId: project.id, sessionId: crypto.randomUUID(), prompt: "hello", onEvent: () => {},
    beforeStart: async () => { throw new Error("You stopped the turn"); },
  }).then(async run => { await run.done; return "spawned"; }, error => error.message);
  assert.equal(result, "You stopped the turn", "a stopped turn must not spawn after setup finishes");
});

/** When Joint Bob stops a turn, the turn fails with why it was stopped, not with how the process died. */
test("a Claude turn Joint Bob stops fails with the stop reason", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-stop-"));
  const fakeClaude = path.join(root, "claude-fake");
  await writeFile(fakeClaude, [
    "#!/bin/sh",
    "cat >/dev/null",
    `echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Still working."}]}}'`,
    "exec sleep 30",
    "",
  ].join("\n"), "utf8");
  await chmod(fakeClaude, 0o755);
  updateSettings({
    projects: { homePath: path.join(root, "home") },
    claude: { executable: fakeClaude, configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
  });
  const project = await addProject(`claude-stop-${Date.now()}`, path.join(root, "project"), { writeInstructions: false });
  const runtime = await getHarnessRuntime("claude");
  const session = await runtime.open({ projectId: project.id, cwd: project.path, sessionId: crypto.randomUUID(), accountIds: [] });
  let answered!: () => void;
  const streaming = new Promise<void>((resolve) => { answered = resolve; });
  session.subscribe((event: HarnessEvent) => { if (event.type === "textDelta") answered(); });

  const turn = session.prompt({ text: "hello" });
  await streaming;
  const failed = assert.rejects(turn, { message: "Joint Bob stopped the turn after 5 minutes with no input or output" });
  await session.cancel("Joint Bob stopped the turn after 5 minutes with no input or output");
  await failed;
});
