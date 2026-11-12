// Writes a .tar.gz without a subprocess: ustar entries, with a PAX record in front of an entry whose
// name the 100 bytes of a ustar header cannot hold. Any tar reads the result. It is what a backup
// needs and no more: regular files and in-memory entries, no links, no folders of their own.
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export interface TarEntry {
  /** The name inside the archive: relative, with forward slashes. */
  name: string;
  /** A regular file whose content becomes the entry. */
  file?: string;
  /** Or the content itself. */
  data?: Buffer;
  /** Milliseconds; the file's own time when absent. */
  modifiedAt?: number;
}

const BLOCK = 512;
const NAME_BYTES = 100;
/** What the eleven octal digits of a ustar size hold. */
const MAX_ENTRY_BYTES = 8 * 1024 ** 3 - 1;

function octal(value: number, digits: number): string {
  return `${Math.floor(value).toString(8).padStart(digits, "0")}\0`;
}

function header(name: Buffer, size: number, modifiedAt: number, type: "0" | "x"): Buffer {
  const block = Buffer.alloc(BLOCK);
  name.copy(block, 0, 0, Math.min(name.length, NAME_BYTES));
  block.write(octal(0o600, 7), 100, "latin1");
  block.write(octal(0, 7), 108, "latin1");
  block.write(octal(0, 7), 116, "latin1");
  block.write(octal(size, 11), 124, "latin1");
  block.write(octal(Math.max(0, modifiedAt / 1000), 11), 136, "latin1");
  // The checksum is taken with its own field read as eight spaces.
  block.write("        ", 148, "latin1");
  block.write(type, 156, "latin1");
  block.write("ustar\0" + "00", 257, "latin1");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

/** One PAX record: its own length in bytes, a space, key=value, a newline. The length counts its own digits. */
function paxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(` ${key}=${value}\n`, "utf8");
  let length = body.length;
  for (;;) {
    const next = body.length + String(length).length;
    if (next === length) break;
    length = next;
  }
  return Buffer.concat([Buffer.from(String(length), "latin1"), body]);
}

function padding(size: number): Buffer {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** The start of the name, cut where a character ends, for readers that ignore the PAX record. */
function shortName(name: string): Buffer {
  let short = "";
  for (const character of name) {
    if (Buffer.byteLength(short + character) > NAME_BYTES) break;
    short += character;
  }
  return Buffer.from(short, "utf8");
}

function checkedName(name: string): string {
  const parts = name.split("/");
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0") || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`An archive entry cannot be named ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Writes the entries to `destination` as a gzip-compressed tar and returns the archive's size. The
 * destination must not exist. A file is read to the size it had when its entry started; one that
 * got shorter meanwhile fails the archive. Whatever fails, no partial archive is left behind.
 */
export async function writeTarGz(destination: string, entries: Iterable<TarEntry> | AsyncIterable<TarEntry>): Promise<{ bytes: number; entries: number }> {
  // Opened here, before anything is written: a destination that exists is refused and left as it is.
  const handle = await open(destination, "wx", 0o600);
  const gzip = createGzip();
  const done = pipeline(gzip, handle.createWriteStream());
  // A disk that fills up fails the pipeline while a write below waits for room: the wait ends with that failure.
  const failure = new Promise<never>((_resolve, reject) => { done.catch(reject); });
  failure.catch(() => undefined);
  const write = async (chunk: Buffer): Promise<void> => {
    if (!chunk.length) return;
    if (gzip.destroyed) await failure;
    if (!gzip.write(chunk)) await Promise.race([once(gzip, "drain"), failure]);
  };
  let count = 0;
  try {
    for await (const entry of entries) {
      const name = checkedName(entry.name);
      const info = entry.file ? await stat(entry.file) : undefined;
      if (info && !info.isFile()) throw new Error(`${entry.file} is not a regular file`);
      const size = info ? info.size : entry.data?.length ?? 0;
      if (size > MAX_ENTRY_BYTES) throw new Error(`${entry.file ?? name} is too large for the archive`);
      const modifiedAt = entry.modifiedAt ?? info?.mtimeMs ?? Date.now();
      const nameBytes = Buffer.from(name, "utf8");
      if (nameBytes.length > NAME_BYTES) {
        const record = paxRecord("path", name);
        await write(header(Buffer.from(`PaxHeaders/${count}`, "latin1"), record.length, modifiedAt, "x"));
        await write(record);
        await write(padding(record.length));
      }
      await write(header(nameBytes.length > NAME_BYTES ? shortName(name) : nameBytes, size, modifiedAt, "0"));
      if (entry.file) {
        let read = 0;
        if (size > 0) {
          for await (const chunk of createReadStream(entry.file, { start: 0, end: size - 1 })) {
            read += (chunk as Buffer).length;
            await write(chunk as Buffer);
          }
        }
        if (read !== size) throw new Error(`${entry.file} changed while it was being archived`);
      } else if (entry.data) {
        await write(entry.data);
      }
      await write(padding(size));
      count += 1;
    }
    // Two empty blocks end a tar.
    await write(Buffer.alloc(BLOCK * 2));
    gzip.end();
    await done;
  } catch (error) {
    gzip.destroy();
    await done.catch(() => undefined);
    await rm(destination, { force: true });
    throw error;
  }
  return { bytes: (await stat(destination)).size, entries: count };
}

/**
 * The entries of a .tar.gz this module wrote, by name with their sizes: the archive is read back
 * whole, so a file that was not written completely or does not decompress fails here. Used to check
 * a backup before the original is deleted.
 */
export async function readTarGzEntries(archive: string): Promise<Array<{ name: string; bytes: number }>> {
  const entries: Array<{ name: string; bytes: number }> = [];
  let pending: Buffer = Buffer.alloc(0);
  /** Bytes of the current entry's content and padding still to pass; `record` gathers a PAX record's content. */
  let skip = 0, record: Buffer[] | undefined, recordBytes = 0, longName: string | undefined, ended = false;
  const take = (chunk: Buffer): void => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (skip > 0) {
        if (!pending.length) return;
        const part = pending.subarray(0, Math.min(skip, pending.length));
        if (record && recordBytes > 0) { const content = part.subarray(0, Math.min(recordBytes, part.length)); record.push(content); recordBytes -= content.length; }
        skip -= part.length;
        pending = pending.subarray(part.length);
        if (skip === 0 && record) {
          const text = Buffer.concat(record).toString("utf8");
          const found = /^\d+ path=([^\n]*)\n/m.exec(text);
          if (found) longName = found[1];
          record = undefined;
        }
        continue;
      }
      if (pending.length < BLOCK) return;
      const block = pending.subarray(0, BLOCK);
      pending = pending.subarray(BLOCK);
      if (block.every((byte) => byte === 0)) { ended = true; continue; }
      if (ended) throw new Error("The archive continues after its end");
      let sum = 0;
      for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 32 : block[index];
      if (sum !== Number.parseInt(block.toString("latin1", 148, 154), 8)) throw new Error("The archive has a damaged entry");
      const size = Number.parseInt(block.toString("latin1", 124, 135), 8);
      const type = block.toString("latin1", 156, 157);
      skip = size + ((BLOCK - (size % BLOCK)) % BLOCK);
      if (type === "x") { record = []; recordBytes = size; continue; }
      const end = block.indexOf(0);
      entries.push({ name: longName ?? block.toString("utf8", 0, end < 0 || end > NAME_BYTES ? NAME_BYTES : end), bytes: size });
      longName = undefined;
    }
  };
  const { createGunzip } = await import("node:zlib");
  for await (const chunk of createReadStream(archive).pipe(createGunzip())) take(chunk as Buffer);
  if (!ended || skip > 0 || pending.length) throw new Error("The archive is cut short");
  return entries;
}
