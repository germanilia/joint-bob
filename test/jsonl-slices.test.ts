// Large transcripts are read a slice at a time so the process keeps answering while one is parsed.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
