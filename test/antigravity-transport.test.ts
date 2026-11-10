import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { createAntigravityConnection } from "../src/harnesses/antigravity/transport.js";

test("Antigravity malformed RPC errors reject the pending request", async () => {
  const child = spawn(process.execPath, ["-e", `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { message: 'missing code' } }) + '\\n');
    });
  `], { stdio: ["pipe", "pipe", "pipe"] });
  const connection = createAntigravityConnection(child, () => {}, async () => null);
  let timer: NodeJS.Timeout | undefined;
  try {
    await assert.rejects(Promise.race([
      connection.request("initialize", {}),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("RPC request never settled")), 2_000); }),
    ]), /Invalid Antigravity ACP JSON-RPC error/);
  } finally {
    clearTimeout(timer);
    child.kill();
    await connection.closed;
  }
});
