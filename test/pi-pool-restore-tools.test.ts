import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { createAgentSession, getAgentDir, SessionManager, SettingsManager } from "../src/pi-sdk.js";
import { createSessionModelRuntime } from "../src/provider-profiles/pi.js";
import { PiSession } from "../src/harnesses/pi/runtime.js";

interface ModelRequest { tools?: unknown[]; messages: Array<{ role: string }> }

/** A model endpoint that refuses its first request, as a pool member out of quota does, and answers the rest. */
async function fixtureModel(): Promise<{ baseUrl: string; requests: ModelRequest[]; close: () => Promise<void> }> {
  const requests: ModelRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelRequest);
      if (requests.length === 1) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "You have hit your usage limit", type: "invalid_request_error" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "custom-model",
        choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.end(`${chunk({ role: "assistant", content: "Done." }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test("the pool member that takes over after a refused attempt still gets the system prompt and the tools", async () => {
  const model = await fixtureModel();
  const file = path.join(getAgentDir(), "models.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ providers: { "custom-fixture": { api: "openai-completions", baseUrl: model.baseUrl, models: [{ id: "custom-model" }] } } }));
  const runtime = await createSessionModelRuntime(async (provider) => provider === "custom-fixture" ? { type: "api_key", key: "fixture-app-account" } : undefined,
    async () => [{ providerId: "custom-fixture", type: "api_key" }]);
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel("custom-fixture", "custom-model")!,
    sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }) });
  const handle = { session, safeguardsEnabled: true, dispose: () => session.dispose() };
  const harness = new PiSession({ projectId: "fixture", cwd: process.cwd(), sessionId: session.sessionId }, handle as never);
  try {
    const checkpoint = await harness.checkpointPoolAttempt();
    await session.prompt("List the files").catch(() => undefined);
    assert.equal(model.requests.length, 1);
    const offered = model.requests[0].tools?.length ?? 0;
    assert.ok(offered > 0, "the first attempt offers the tools");

    await harness.restorePoolAttempt(checkpoint);
    await session.prompt("List the files");
    assert.equal(model.requests.length, 2);
    const retried = model.requests[1];
    assert.equal(retried.tools?.length ?? 0, offered, "the attempt after the rewind offers the same tools");
    assert.ok(retried.messages.some((message) => message.role === "system" || message.role === "developer"), "and carries the system prompt");
    assert.equal(retried.messages.filter((message) => message.role === "user").length, 1, "the refused attempt's prompt is not sent twice");
  } finally {
    harness.dispose();
    await model.close();
    await rm(file, { force: true });
  }
});
