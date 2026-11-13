import { readFile } from "node:fs/promises";

/** How much of a transcript is parsed before other work gets a turn. Parsing this much takes a few tens of milliseconds. */
const SLICE_BYTES = 4 * 1024 * 1024;

/**
 * The lines of a JSONL file, a slice at a time, empty lines left out. Between slices other work
 * gets a turn, so a caller that parses a transcript of a hundred megabytes does not hold the
 * process for seconds: reading one as a single string, splitting it and parsing every line in one
 * go did (a scheduled conversation of 170 MB on a node, 2026-11-11). The file is read as bytes
 * and cut at newlines; a newline is never part of a longer UTF-8 character, so each line decodes
 * to what it was. A last line without its newline is given too.
 */
export async function* jsonlLineSlices(file: string, sliceBytes = SLICE_BYTES): AsyncGenerator<string[]> {
  const bytes = await readFile(file);
  let from = 0;
  while (from < bytes.length) {
    const lines: string[] = [];
    // A line that starts inside the slice is finished even when it runs past it.
    const until = Math.min(bytes.length, from + sliceBytes);
    while (from < until) {
      let end = bytes.indexOf(10, from);
      if (end < 0) end = bytes.length;
      if (end > from) lines.push(bytes.toString("utf8", from, end));
      from = end + 1;
    }
    yield lines;
    if (from < bytes.length) await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

/** Append-only transcripts can end mid-record while an agent writes. Completed
 * lines must parse; a valid last record is also accepted without a newline. */
export function parseCompletedJsonl(contents: string): unknown[] {
  const lines = contents.split("\n");
  const tail = lines.pop()!;
  const records = lines.filter((line) => line.trim()).map((line) => JSON.parse(line));
  if (tail.trim()) {
    try { records.push(JSON.parse(tail)); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return records;
}

const reportedDamage = new Set<string>();

/**
 * One line of a transcript being opened: undefined when it does not parse, said once per file.
 * fix: a full disk cut a record short and the next record was written onto the same line (homeserver, 2026-11-13);
 * opening that conversation failed with "Expected ',' or '}' after property value" and never recovered.
 */
export function parseJsonlLineSkippingDamage(line: string, file: string): unknown {
  try { return JSON.parse(line); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (!reportedDamage.has(file)) {
      reportedDamage.add(file);
      console.warn(`Transcript ${file} has a damaged line; it is skipped`);
    }
    return undefined;
  }
}

/**
 * For conversation lists and usage totals: a completed line that does not parse is skipped, and said once per file.
 * fix: a write cut short by a full disk, followed by a newline (homeserver, 2026-10-26), failed every list holding
 * that transcript, /api/running among them. Forks keep parseCompletedJsonl: they must not copy a damaged history.
 */
export function parseJsonlSkippingDamage(contents: string, file: string): unknown[] {
  const lines = contents.split("\n");
  const tail = lines.pop()!;
  const records: unknown[] = [];
  let damaged = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; damaged++; }
  }
  if (tail.trim()) {
    try { records.push(JSON.parse(tail)); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  if (damaged && !reportedDamage.has(file)) {
    reportedDamage.add(file);
    console.warn(`Transcript ${file} has ${damaged} damaged ${damaged === 1 ? "line" : "lines"}; ${damaged === 1 ? "it is" : "they are"} skipped`);
  }
  return records;
}
