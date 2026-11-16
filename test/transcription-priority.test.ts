import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("the local transcription worker never raises an inherited background priority", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-transcribe-priority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const decoder = path.join(root, "decode.mjs");
  await writeFile(decoder, `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(8));\n`);
  await chmod(decoder, 0o700);
  const loader = path.join(root, "loader.mjs");
  await writeFile(loader, `
    import os from "node:os";
    export const env = {};
    export const ffmpegPath = ${JSON.stringify(decoder)};
    export class Tensor {}
    export async function pipeline() {
      const transcriber = async () => ({ text: "priority " + os.getPriority() });
      transcriber.processor = async () => ({ input_features: {} });
      transcriber.model = Object.assign(async () => ({ logits: { data: [1] } }), {
        generation_config: { decoder_start_token_id: 0, lang_to_id: { "<|en|>": 0 } },
      });
      return transcriber;
    }
  `);
  const wrapper = path.join(root, "background.mjs");
  await writeFile(wrapper, `import os from "node:os"; os.setPriority(19); await import(${JSON.stringify(new URL("../bin/joint-bob-transcribe.mjs", import.meta.url).href)});\n`);
  const { stdout } = await execute(process.execPath, [wrapper, loader, path.join(root, "cache"), path.join(root, "audio")]);
  assert.deepEqual(JSON.parse(stdout), { text: "priority 19", cut: false });
});
