import assert from "node:assert/strict";
import test from "node:test";
import { assessTask } from "../src/task-assessment.js";

const target = { endpoint: "http://127.0.0.1:1/fixture", model: "fixture-v1", stateCharacters: 8000, timeoutMs: 1000 };
test("domain, complexity and risk are independent questions in one bounded request", async () => {
  let calls = 0;
  const fetcher = async (_url: unknown, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    assert.deepEqual(Object.keys(body.questions).sort(), ["complexity", "domain", "risk"]);
    return Response.json({ answers: { domain: { type: "choice", choice: "software-repair", confidence: 0.9 }, complexity: { type: "choice", choice: "4", confidence: 0.8 }, risk: { type: "choice", choice: "high", confidence: 0.95 } } });
  };
  const assessment = await assessTask({ taskId: "task", text: "Repair payment validation", capabilities: ["terminal"] }, target, "fixture", fetcher as typeof fetch);
  assert.equal(calls, 1);
  assert.equal(assessment.domain, "software-repair"); assert.equal(assessment.risk, "high"); assert.equal(assessment.complexity, 4);
  assert.equal(assessment.confidence, 0.8);
  assert.ok(!("text" in assessment));
});
test("missing, unsupported and over-budget assessments fail explicitly without changing any model", async () => {
  const unavailable = async () => Response.json({ answers: {} });
  await assert.rejects(assessTask({ taskId: "task", text: "Fix", capabilities: [] }, target, "fixture", unavailable as typeof fetch), /assessment unavailable/i);
  await assert.rejects(assessTask({ taskId: "task", text: "x".repeat(9000), capabilities: [] }, target, "fixture", unavailable as typeof fetch), /budget/i);
});
