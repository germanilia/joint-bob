import assert from "node:assert/strict";
import test from "node:test";
import { conversationRuntimeDatabase } from "../src/conversation-runtime.js";
import { agentWorkActive, conversationWorkActive, listConversationWork, recordConversationWork } from "../src/conversation-work.js";
import type { AgentRunSummary, HarnessId } from "../src/types.js";
import { counting, touching } from "./perf-statement-counter.js";

/* conversationWorkActive is asked once per listed conversation in every listing. It used to read
   and parse every run the conversation ever had. It now reads only the rows the unfinished index
   holds, and must give the answer the full read gives. */

const engine = "claude" as HarnessId;
const finished = (runId: string): AgentRunSummary => ({ runId, status: "succeeded", tasks: [{ name: "worker", role: "worker", status: "succeeded" }] }) as AgentRunSummary;
const fullRead = (sessionId: string): boolean => listConversationWork(engine, sessionId).some((work) => agentWorkActive(work.summary));
const both = (sessionId: string): boolean => {
  const answer = conversationWorkActive(engine, sessionId);
  assert.equal(answer, fullRead(sessionId), `conversationWorkActive and the full read disagree for ${sessionId}`);
  return answer;
};

test("whether work is going is the answer the full read gives", () => {
  assert.equal(both("perf-none"), false);

  for (let run = 0; run < 40; run++) recordConversationWork({ engine, sessionId: "perf-history", summary: finished(`done-${run}`) });
  assert.equal(both("perf-history"), false);
  recordConversationWork({ engine, sessionId: "perf-history", summary: { runId: "going", status: "running", tasks: [] } as AgentRunSummary });
  assert.equal(both("perf-history"), true);
  assert.equal(both("perf-none"), false, "another conversation's run is not this one's");
  recordConversationWork({ engine, sessionId: "perf-history", summary: finished("going") });
  assert.equal(both("perf-history"), false, "finished right after it was recorded so");

  // A run that has ended while one of its tasks has not.
  recordConversationWork({ engine, sessionId: "perf-task", summary: { runId: "parent", status: "succeeded", tasks: [{ name: "late", role: "worker", status: "queued" }] } as AgentRunSummary });
  assert.equal(both("perf-task"), true);
  recordConversationWork({ engine, sessionId: "perf-task", summary: { runId: "parent", status: "succeeded", tasks: [{ name: "late", role: "worker", status: "failed", error: "status: running was expected" }] } as AgentRunSummary });
  assert.equal(both("perf-task"), false, "the words in an error text do not make a run go");
  recordConversationWork({ engine, sessionId: "perf-queued", summary: { runId: "waiting", status: "queued", tasks: [] } as AgentRunSummary });
  assert.equal(both("perf-queued"), true);
});

test("a conversation's finished runs are not read to learn that nothing is going", () => {
  for (let run = 0; run < 300; run++) recordConversationWork({ engine, sessionId: "perf-long", summary: finished(`done-${run}`) });
  const full = counting(() => fullRead("perf-long"));
  assert.equal(full.parses, 300);
  const narrow = counting(() => conversationWorkActive(engine, "perf-long"));
  assert.equal(narrow.result, false);
  assert.equal(narrow.parses, 0);
  assert.equal(touching(narrow, "conversation_work"), 1);
  assert.equal(narrow.statements.length, 1);

  recordConversationWork({ engine, sessionId: "perf-long", summary: { runId: "going", status: "running", tasks: [] } as AgentRunSummary });
  const going = counting(() => conversationWorkActive(engine, "perf-long"));
  assert.equal(going.result, true);
  assert.equal(going.parses, 1, "only the run that may be going is parsed");

  // The rows are reached through the index of unfinished runs, not by walking the conversation's history.
  const plan = (conversationRuntimeDatabase().prepare(`EXPLAIN QUERY PLAN ${narrow.statements[0]}`).all(engine, "perf-long") as Array<{ detail: string }>).map((row) => row.detail).join("; ");
  assert.match(plan, /SEARCH .*conversation_work_unfinished/, plan);
});

test("a record that cannot be read is an error from both", () => {
  recordConversationWork({ engine, sessionId: "perf-broken", summary: finished("fine") });
  conversationRuntimeDatabase().prepare("INSERT INTO conversation_work VALUES (?, ?, ?, ?)").run(engine, "perf-broken", "broken", "{not json");
  assert.throws(() => fullRead("perf-broken"), SyntaxError);
  assert.throws(() => conversationWorkActive(engine, "perf-broken"), SyntaxError);
});
