import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { seedDevEnvironment, startDevNode, stopDevNode } from "./dev-nodes.js";

// The valid frame lets body-parser finish reading JSON before the decoder sees the
// invalid suffix. Older body-parser leaves the decoder's error unhandled.
test("unauthenticated compressed JSON with trailing garbage cannot crash the server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compressed-request-security-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  try {
    const frame = gzipSync(Buffer.from('{}'));
    const suffix = Buffer.concat([Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
    const status = await new Promise<number>((resolve, reject) => {
      const upload = request(`${node.url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": frame.length + suffix.length },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode!));
      });
      upload.once("error", reject);
      upload.setTimeout(5_000, () => upload.destroy(new Error("Upload timed out")));
      upload.end(Buffer.concat([frame, suffix]));
    });
    assert.equal(status, 400, "malformed login input must reach validation and return a client error");
    const health = await fetch(`${node.url}/api/health`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(health.status, 200, "the server must survive a malformed compressed request");
    assert.equal(server.exitCode, null);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
