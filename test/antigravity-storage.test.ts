import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";
import { appendAntigravityRecord, initializeAntigravitySession, listAntigravitySessions, loadAntigravityMessages, readAntigravitySession, antigravitySessionFilePath } from "../src/harnesses/antigravity/storage.js";

const timestamp = "2026-11-10T12:00:00.000Z";

test("Google Antigravity transcript restores native session, settings, messages and history summary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-storage-")), previous = getSettings();
  try {
    updateSettings({ runtimes: { ...previous.runtimes, antigravity: { ...previous.runtimes.antigravity, sessionPath: path.join(root, "sessions") } } });
    const project = await addProject("Antigravity storage fixture", root, { writeInstructions: false });
    const options = { projectId: project.id, cwd: root, sessionId: "antigravity-storage-1" };
    const file = await initializeAntigravitySession(options, { provider: "antigravity", modelId: "default", reasoning: "medium" });
    await appendAntigravityRecord(file, { type: "native-session", id: "native-session-1", profileId: "profile-antigravity-1", handoffPending: true, timestamp });
    await appendAntigravityRecord(file, { type: "message", role: "user", text: "Inspect Antigravity storage", timestamp });
    await appendAntigravityRecord(file, { type: "settings", modelId: "gemini-3.1-pro", reasoning: "high", enabledTools: ["commands"], timestamp });
    await appendAntigravityRecord(file, { type: "message", role: "assistant", text: "Transcript restored", modelId: "gemini-3.1-pro", reasoning: "high", timestamp });
    await appendAntigravityRecord(file, { type: "tool", toolName: "read_file", text: "file contents", durationMs: 12, timestamp });

    const restored = await readAntigravitySession(file);
    assert.equal(restored.nativeSessionId, "native-session-1");
    assert.equal(restored.nativeProfileId, "profile-antigravity-1");
    assert.equal(restored.handoffPending, true);
    assert.deepEqual({ modelId: restored.modelId, reasoning: restored.reasoning, enabledTools: restored.enabledTools }, {
      modelId: "gemini-3.1-pro", reasoning: "high", enabledTools: ["commands"],
    });
    assert.deepEqual(restored.messages.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "Inspect Antigravity storage" },
      { role: "assistant", text: "Transcript restored" },
      { role: "toolResult", text: "file contents" },
    ]);
    assert.equal((await loadAntigravityMessages(project, `antigravity:${file}`)).length, 3);
    assert.deepEqual((await listAntigravitySessions(project)).map(({ id, title, firstMessage }) => ({ id, title, firstMessage })), [
      { id: options.sessionId, title: "Inspect Antigravity storage", firstMessage: "Inspect Antigravity storage" },
    ]);
    assert.throws(() => antigravitySessionFilePath("../outside"), /session ID must be safe/);
  } finally {
    updateSettings({ runtimes: previous.runtimes });
    await rm(root, { recursive: true, force: true });
  }
});

test("listing an unchanged Antigravity transcript does not read it again, and a changed one is read at once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-listing-cache-")), previous = getSettings();
  try {
    updateSettings({ runtimes: { ...previous.runtimes, antigravity: { ...previous.runtimes.antigravity, sessionPath: path.join(root, "sessions") } } });
    const project = await addProject("Antigravity listing cache fixture", root, { writeInstructions: false });
    const file = await initializeAntigravitySession({ projectId: project.id, cwd: root, sessionId: "antigravity-cache-1" }, { provider: "antigravity", modelId: "default", reasoning: "medium" });
    await appendAntigravityRecord(file, { type: "message", role: "user", text: "First title", timestamp });
    const titles = async () => (await listAntigravitySessions(project)).map((session) => session.title);
    const wholeSecond = new Date(Math.floor(Date.now() / 1000) * 1000);
    await utimes(file, wholeSecond, wholeSecond);
    assert.deepEqual(await titles(), ["First title"]);

    // Same size and modification time, different words: only a re-read would notice.
    await writeFile(file, (await readFile(file, "utf8")).replace("First title", "Other title"));
    await utimes(file, wholeSecond, wholeSecond);
    assert.deepEqual(await titles(), ["First title"]);

    await appendAntigravityRecord(file, { type: "title", title: "Renamed", timestamp });
    assert.deepEqual(await titles(), ["Renamed"]);
  } finally {
    updateSettings({ runtimes: previous.runtimes });
    await rm(root, { recursive: true, force: true });
  }
});
