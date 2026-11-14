import assert from "node:assert/strict";
import test from "node:test";
import { ANSWER_LIMIT, cardDetail } from "../src/control-center/card-detail.js";
import { PUSH_PREFIX } from "../src/control-center/review-check.js";

test("a card's detail is the last ask, the agent's last message and its last steps", () => {
  const detail = cardDetail([
    { id: "1", role: "user", text: "fix the menu" },
    { id: "2", role: "assistant", text: "Looking." },
    ...Array.from({ length: 7 }, (_, index) => ({ id: `t${index}`, role: "toolResult", text: "ok", toolName: "Bash", toolTarget: { target: `step ${index}` }, ...(index === 6 ? { isError: true } : {}) })),
    { id: "3", role: "user", text: `${PUSH_PREFIX} (nothing yet).` },
    { id: "4", role: "assistant", text: "Shall I delete the old menu, or keep it?", timestamp: "2026-11-12T10:00:00.000Z" },
  ]);
  assert.equal(detail.request, "fix the menu", "Bob's own pushes are not what the person asked");
  assert.equal(detail.answer, "Shall I delete the old menu, or keep it?");
  assert.equal(detail.answerAt, "2026-11-12T10:00:00.000Z");
  assert.equal(detail.answerCut, false);
  assert.deepEqual(detail.steps.map((step) => step.target), ["step 2", "step 3", "step 4", "step 5", "step 6"]);
  assert.equal(detail.steps.at(-1)?.failed, true);
});

test("a very long answer keeps its end and says it was cut; an empty transcript is empty", () => {
  const long = `${"a".repeat(ANSWER_LIMIT)}THE END`;
  const detail = cardDetail([{ id: "1", role: "assistant", text: long }]);
  assert.equal(detail.answerCut, true);
  assert.equal(detail.answer.length, ANSWER_LIMIT);
  assert.ok(detail.answer.endsWith("THE END"));
  assert.deepEqual(cardDetail([]), { request: "", answer: "", answerAt: null, answerCut: false, steps: [] });
});

test("the attachment index the app adds to a message is not shown as what was asked", () => {
  const detail = cardDetail([{ id: "1", role: "user", text: "look at this\n\nImage attachments:\n- shot.png: /tmp/shot.png" }]);
  assert.equal(detail.request, "look at this");
});
