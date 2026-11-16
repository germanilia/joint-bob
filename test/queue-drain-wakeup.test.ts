import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("harness-chat.ts", readFileSync(new URL("../src/server/harness-chat.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const functions = ["deferredAutoPrompt", "drainLoop"].map(name => source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)!.getText(source)).join("\n");
const compiled = ts.transpileModule(`${functions}\nexports.drainLoop = drainLoop;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function fixture(deferred: boolean) {
  const queue: Array<{ id: string; scheduledAutoRespond?: object }> = [];
  const dispatched: string[] = [];
  const state = { status: "active", sourcePromptId: "other-run" };
  let decisions = 0;
  const connection = { project: { id: "project" }, conversationId: "conversation", shared: { session: {} } };
  const exports: { drainLoop?: (connection: unknown) => Promise<void> } = {};
  vm.runInNewContext(compiled, {
    exports, queueKey: () => "project:conversation", getAutoRespond: async () => state,
    ensureCurrentSession: async () => {}, pausedDrains: new Set(), promptQueuePaused: () => false,
    harnessTurnBusy: () => false, listQueuedPrompts: () => queue,
    autoCompactBetweenTurns: async () => {}, getSettings: () => ({ autoCompactThreshold: null }),
    dispatch: async (_connection: unknown, prompt: { id: string }) => { dispatched.push(prompt.id); queue.shift(); },
    runGoalTurn: async () => false,
    runAutoResponse: async () => {
      decisions++;
      assert.ok(decisions <= 2, "a deferred scheduled prompt must not spin the drain");
      if (decisions === 1) queue.push({ id: "arrived-during-check", ...(deferred ? { scheduledAutoRespond: {} } : {}) });
      await Promise.resolve();
      return false;
    },
  });
  return { queue, dispatched, drain: () => exports.drainLoop!(connection) };
}

test("a human prompt arriving during an automatic reply check is drained without another wake-up", async () => {
  const fixture_ = fixture(false);
  await fixture_.drain();
  assert.deepEqual(fixture_.dispatched, ["arrived-during-check"]);
  assert.equal(fixture_.queue.length, 0);
});

test("a scheduled prompt owned by another active responder stays deferred without spinning", async () => {
  const fixture_ = fixture(true);
  await fixture_.drain();
  assert.deepEqual(fixture_.dispatched, []);
  assert.equal(fixture_.queue.length, 1);
});
