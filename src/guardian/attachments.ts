import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { describeImage } from "../attachment-digest.js";

const MIME_BY_EXTENSION: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** Put after a message's text so what Guardian read from the pictures can be cut off again. */
export const IMAGE_CONTENTS_MARKER = "\n\nImage contents (read for Guardian):\n";

const described = new Map<string, string>();

/** The paths of the images a message lists under "Image attachments:". */
function listedImages(text: string): Array<{ name: string; file: string }> {
  const start = text.indexOf("Image attachments:\n");
  if (start < 0) return [];
  const lines = text.slice(start).split("\n").slice(1);
  const images: Array<{ name: string; file: string }> = [];
  for (const line of lines) {
    const found = /^- (.+?): (\/.+)$/.exec(line);
    if (!found) break;
    images.push({ name: found[1], file: found[2] });
  }
  return images;
}

/** Only a file the app itself saved as an attachment: a message cannot make Guardian read any other file. */
async function attachmentFile(file: string): Promise<string> {
  const root = await realpath(path.dirname(file));
  const real = path.join(root, path.basename(file));
  if (path.basename(root) !== ".joint-bob-attachments" || !MIME_BY_EXTENSION[path.extname(real).toLowerCase()]) throw new Error(`${path.basename(file)} is not an attachment image`);
  return real;
}

/**
 * What the pictures a message attaches show, described by a vision model, for Guardian to read.
 * Empty when the message attaches none, or when digest already put a description in the message.
 * Throws when a picture cannot be read or described: the check cannot be trusted without it.
 */
export async function imageContents(text: string): Promise<string> {
  const parts: string[] = [];
  for (const { name, file } of listedImages(text)) {
    if (text.includes(`Description of ${file}`)) continue;
    const real = await attachmentFile(file);
    const data = (await readFile(real)).toString("base64");
    const key = createHash("sha256").update(data).digest("hex");
    if (!described.has(key)) described.set(key, await describeImage({ data, mimeType: MIME_BY_EXTENSION[path.extname(real).toLowerCase()] }));
    parts.push(`${name}:\n${described.get(key)}`);
  }
  return parts.join("\n\n");
}
