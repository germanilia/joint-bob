import assert from "node:assert/strict";
import test from "node:test";
import { socketMessageSchema } from "../src/server/schemas.js";
import { autoRespondConfigSchema, enableAutoRespond, getAutoRespond, recordAutoResponse, resetAutoRespondCount } from "../src/conversation-auto-respond.js";
import { systemControlConfig } from "../src/server/system-control.js";

const model = { harnessId: "pi", provider: "test", modelId: "test", reasoning: "default" };

test("system control accepts optional limits, rejects invalid input and defaults to unlimited", () => {
  const parse = (options: object) => socketMessageSchema.parse({ type: "autoRespond", autoRespond: { enabled: true, systemControl: { instructions: "Verify the feature", ...options } } });
  assert.doesNotThrow(() => parse({ maxResponses: 3, maxMinutes: 15 }));
  assert.doesNotThrow(() => parse({ maxResponses: null, maxMinutes: null }));
  for (const options of [{ maxResponses: 0 }, { maxResponses: 1.5 }, { maxMinutes: 0 }, { maxMinutes: -1 }]) assert.throws(() => parse(options));
  const unlimited = systemControlConfig("", "", model);
  assert.equal(unlimited.maxResponses, null);
  assert.equal(unlimited.systemControl?.deadline, null);
  const limited = systemControlConfig("", "Verify the feature", model, { maxResponses: 3, maxMinutes: 15 });
  assert.equal(limited.maxResponses, 3);
  assert.equal(limited.systemControl?.maxMinutes, 15);
  assert.ok(Math.abs(Date.parse(limited.systemControl!.deadline!) - Date.now() - 900_000) < 1000);
  assert.deepEqual(autoRespondConfigSchema.parse(limited).systemControl, limited.systemControl);
});

test("a human message does not reset a system-control iteration budget", async () => {
  const config = systemControlConfig("", "", model, { maxResponses: 3 });
  const active = await enableAutoRespond("budget-project", "budget-conversation", config, null);
  await recordAutoResponse(active.projectId, active.conversationId, active.revision, "answer-1");
  await resetAutoRespondCount(active.projectId, active.conversationId);
  assert.equal((await getAutoRespond(active.projectId, active.conversationId))?.responses, 1);
});

test("completion requires coverage, working feature and deployment only when requested", () => {
  const config = systemControlConfig("", "", model);
  assert.match(config.stopInstructions, /test coverage/);
  assert.match(config.stopInstructions, /deployment.*explicitly requested/i);
  assert.match(config.stopInstructions, /Guardian/);
});
