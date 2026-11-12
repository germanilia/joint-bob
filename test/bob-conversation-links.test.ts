import assert from "node:assert/strict";
import test from "node:test";
import { bobConversationLinks } from "../src/control-center/bob-conversation-links.js";

const conversations = [
  { projectId: "contigos", conversationId: "assistant", title: "adding new personal assistant" },
  { projectId: "contigos", conversationId: "plan", title: "plan personal assistant" },
];
test("Bob's identified conversation becomes an explicit Open action, not an automatic navigation", () => {
  const result = bobConversationLinks("Use [[conversation:0]] to continue.", conversations);
  assert.equal(result.text, "Use adding new personal assistant to continue.");
  assert.deepEqual(result.actions, [{ id: "open", label: "Open: adding new personal assistant", data: { open: conversations[0] } }]);
});
test("multiple matches remain separate choices and repeated references are deduplicated", () => {
  const result = bobConversationLinks("[[conversation:0]] or [[conversation:1]]; [[conversation:0]]", conversations);
  assert.deepEqual(result.actions.map((action) => action.data), conversations.map((open) => ({ open })));
});
test("invented indices and plain mentions cannot create unrelated cards", () => {
  assert.deepEqual(bobConversationLinks("Found [[conversation:99]]", conversations), { text: "Found", actions: [] });
  assert.deepEqual(bobConversationLinks("auto model selector", conversations), { text: "auto model selector", actions: [] });
});
