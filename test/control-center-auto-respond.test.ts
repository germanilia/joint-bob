import assert from "node:assert/strict";
import test from "node:test";
import { autoRespondConfigSchema } from "../src/conversation-auto-respond.js";
import { BOB_AUTO_RESPOND_LIMIT, BOB_AUTO_RESPOND_STOP_INSTRUCTIONS, BOB_DELEGATION_LIMIT, bobAutoRespondConfig, bobDelegationConfig, bobWantsAutoRespond, DELEGATION_BRIEF, readyForReview } from "../src/control-center/auto-respond.js";
import { DEFAULT_BOB_SETTINGS } from "../src/control-center/bob-store.js";
import type { BobDecision } from "../src/control-center/decisions.js";

const routine: BobDecision = { kind: "task", size: "long", projectId: "p", autoRespond: true, confidence: 0.95 };

test("Bob turns auto respond on only for routine tasks, and only when the person let Bob decide", () => {
  assert.equal(bobWantsAutoRespond(DEFAULT_BOB_SETTINGS, routine), true);
  assert.equal(bobWantsAutoRespond(DEFAULT_BOB_SETTINGS, { ...routine, autoRespond: false }), false, "the decision model found it not routine");
  assert.equal(bobWantsAutoRespond(DEFAULT_BOB_SETTINGS, { ...routine, kind: "question" }), false);
  assert.equal(bobWantsAutoRespond({ ...DEFAULT_BOB_SETTINGS, autoRespond: "always" }, { ...routine, autoRespond: false }), true, "the person asked Bob to always answer");
  assert.equal(bobWantsAutoRespond({ ...DEFAULT_BOB_SETTINGS, autoRespond: "always" }, { ...routine, kind: "question" }), false, "only tasks start agents");
  assert.equal(bobWantsAutoRespond({ ...DEFAULT_BOB_SETTINGS, autoRespond: "never" }, routine), false);
});

test("the responder stops for plans, user-facing decisions and production steps, and fits the auto respond schema", async () => {
  assert.match(BOB_AUTO_RESPOND_STOP_INSTRUCTIONS, /plan or a design/);
  assert.match(BOB_AUTO_RESPOND_STOP_INSTRUCTIONS, /production/);
  assert.match(BOB_AUTO_RESPOND_STOP_INSTRUCTIONS, /destructive/, "the default stop instructions are kept");
  const config = await bobAutoRespondConfig({ ...DEFAULT_BOB_SETTINGS, provider: "anthropic", modelId: "opus", thinkingLevel: "high" }, "claude");
  assert.equal(config.maxResponses, BOB_AUTO_RESPOND_LIMIT);
  assert.equal(config.modelId, "opus");
  assert.doesNotThrow(() => autoRespondConfigSchema.parse(config));
});

test("work handed to Bob is driven to a verified end and comes back for review, or for what only the person can give", async () => {
  const config = await bobDelegationConfig({ ...DEFAULT_BOB_SETTINGS, provider: "anthropic", modelId: "opus", thinkingLevel: "high" }, "claude");
  assert.doesNotThrow(() => autoRespondConfigSchema.parse(config));
  assert.deepEqual([config.modelId, config.maxResponses, config.useTools], ["opus", BOB_DELEGATION_LIMIT, true], "Bob's model, more answers in a row, and tools to check the work");
  assert.match(config.instructions, /Check claims before you accept them/, "the usual checks are kept");
  assert.match(config.instructions, /verified end to end, with evidence you checked/);
  const stops = config.stopInstructions.split("\n");
  assert.match(stops[0], /^- Ready for review: the work is implemented and verified end to end/);
  assert.deepEqual(stops.slice(1).map((line) => /access|decision|cannot be undone|blocked/.test(line)), [true, true, true, true], "otherwise only access, decisions, risky steps or a real block stop it");
  assert.match(DELEGATION_BRIEF, /Ask me only for access only I can give .*, a decision only I can make, or a risky or irreversible step/);
  assert.match(DELEGATION_BRIEF, /end with a review report/);
  assert.equal(readyForReview("Ready for review: ran the tests; all pass."), true);
  assert.equal(readyForReview("The agent needs a token."), false);
  assert.equal(readyForReview(null), false);
});
