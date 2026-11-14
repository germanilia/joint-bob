import assert from "node:assert/strict";
import test from "node:test";
import { systemMessages, type SystemFacts } from "../src/control-center/system-messages.js";

const healthy: SystemFacts = { classifier: "typesafe", decisionModelReady: true, guardian: "on", claudeSignedOut: false, machinesAway: [] };

test("a healthy installation reports nothing", () => {
  assert.deepEqual(systemMessages(healthy), []);
});

test("every problem found becomes one message, with its fix steps and the screen that holds the fix", () => {
  const messages = systemMessages({
    classifier: "laya", decisionModelReady: false, guardian: "rule-off", claudeSignedOut: true,
    machinesAway: [{ id: "n1", name: "Homeserver", conversations: 3 }, { id: "n2", name: "Laptop", conversations: 0 }],
  });
  assert.deepEqual(messages.map((message) => message.id), ["claude-signed-out", "decision-model", "guardian", "machine-away:n1", "machine-away:n2"]);
  for (const message of messages) {
    assert.ok(message.steps.length >= 2, `${message.id} says how to fix it`);
    assert.ok(message.action, `${message.id} has a button to the fix`);
  }
  assert.equal(messages[0].severity, "error", "something that does not work is an error");
  assert.match(messages[1].steps[0], /LAYA_API_KEY/, "the key to add depends on the chosen decision model");
  assert.equal(messages[2].title, "Guardian's production rule is off");
  assert.match(messages[3].short, /3 conversations run there/);
  assert.equal(messages[4].short, "It does not answer", "a machine with no conversations does not claim any");
});

test("the TypeSafe decision model asks for its own key", () => {
  const [message] = systemMessages({ ...healthy, decisionModelReady: false });
  assert.match(message.steps[0], /TYPESAFE_AI_API_KEY/);
  assert.equal(message.severity, "warn", "Bob still answers without it, only slower");
});
