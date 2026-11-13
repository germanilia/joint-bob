// Large transcripts are read a slice at a time so the process keeps answering while one is parsed.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { jsonlLineSlices } from "../src/jsonl.js";

async function linesOf(file: string, sliceBytes?: number): Promise<{ lines: string[]; slices: number }> {
  const lines: string[] = [];
  let slices = 0;
  for await (const slice of jsonlLineSlices(file, sliceBytes)) { slices += 1; lines.push(...slice); }
  return { lines, slices };
}

test("the lines are the ones a split at newlines gives, whatever the slice size", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-jsonl-"));
  try {
    const texts = [
      "",
      "\n\n",
      '{"a":1}',
      '{"a":1}\n',
      '{"a":1}\n\n{"b":"שלום, עולם"}\n{"c":"🙂 emoji and \\n an escaped newline"}',
      Array.from({ length: 500 }, (_, index) => JSON.stringify({ index, text: "é".repeat(index % 37), tail: "x".repeat(index % 91) })).join("\n") + "\n",
      "\r\n{\"a\":1}\r\n",
    ];
    for (const [number, text] of texts.entries()) {
      const file = path.join(root, `${number}.jsonl`);
      await writeFile(file, text);
      const expected = text.split("\n").filter(Boolean);
      for (const sliceBytes of [1, 2, 3, 7, 64, 4096, undefined]) {
        assert.deepEqual((await linesOf(file, sliceBytes)).lines, expected, `text ${number}, slices of ${sliceBytes}`);
      }
    }
    await assert.rejects(linesOf(path.join(root, "missing.jsonl")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("other work gets a turn between slices, and a small file is one slice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-jsonl-"));
  try {
    const file = path.join(root, "long.jsonl");
    const line = JSON.stringify({ text: "x".repeat(1000) });
    await writeFile(file, `${line}\n`.repeat(2000));
    // Something else the process has to do while the file is read: it counts the turns it gets.
    let turns = 0, reading = true;
    const other = (): void => { if (!reading) return; turns += 1; setImmediate(other); };
    setImmediate(other);
    const sliced = await linesOf(file, 100_000);
    reading = false;
    assert.equal(sliced.lines.length, 2000);
    assert.ok(sliced.slices >= 20, `${sliced.slices} slices`);
    assert.ok(turns >= sliced.slices - 1, `other work ran ${turns} times during ${sliced.slices} slices`);
    assert.equal((await linesOf(file)).slices, 1, "two megabytes fit the default slice");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a damaged line is skipped when a transcript is opened", async () => {
  const { parseJsonlLineSkippingDamage } = await import("../src/jsonl.js");
  assert.deepEqual(parseJsonlLineSkippingDamage('{"a":1}', "x.jsonl"), { a: 1 });
  // A record cut short by a full disk, the next one written onto the same line.
  assert.equal(parseJsonlLineSkippingDamage('{"a":"cut sh{"b":2}', "x.jsonl"), undefined);
});

test("opening a Claude conversation survives a damaged line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-jsonl-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const sessionRoot = path.join(root, "claude-sessions");
    const settings = await import(`../src/settings.js?damaged=${Date.now()}`);
    settings.updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: sessionRoot },
    });
    const sessionPaths = await import(`../src/session-paths.js?damaged=${Date.now()}`);
    const claude = await import(`../src/claude-service.js?damaged=${Date.now()}`);
    const projectDir = sessionPaths.claudeProjectDir(path.join(root, "project"), sessionRoot);
    await mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, "session.jsonl");
    const user = (text: string): string => JSON.stringify({ type: "user", message: { role: "user", content: text } });
    await writeFile(file, [user("one"), '{"type":"user","message":{"role":"user","content":"cut sh{"type":"user"}', user("three")].join("\n") + "\n");
    const messages = await claude.loadClaudeMessages(file);
    assert.deepEqual(messages.map((message: { text: string }) => message.text), ["one", "three"]);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
