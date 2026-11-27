import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { resolveDataDirectory } from "../src/data-directory.js";
import { listHarnesses, listHarnessModels } from "../src/harnesses.js";
import type { HarnessRuntime } from "../src/harnesses/runtime.js";
import { harnessProblems } from "../src/server/harness-readiness.js";
import { performanceDiagnostics } from "../src/server/performance-diagnostics.js";

/** Longer than the 500 ms from which the performance log names a single slow operation. */
const slow = async <T>(value: T): Promise<T> => {
  const start = performance.now();
  while (performance.now() - start < 550) await new Promise<void>(resolve => setTimeout(resolve, 10));
  return value;
};

test("readiness, sign-in and model listing are timed per harness", async (t) => {
  // Fake probes: no harness program is started.
  for (const id of ["claude", "pi"] as const) {
    const adapter = listHarnesses().find(harness => harness.id === id)!;
    adapter.runtime = async () => ({ readiness: () => slow([]), signInProblems: () => slow([]) }) as unknown as HarnessRuntime;
    adapter.models = id === "claude" ? () => slow([]) : async () => { await slow(null); throw new Error("private-failure"); };
  }

  await Promise.all([harnessProblems("claude"), harnessProblems("pi")]);
  await listHarnessModels("claude");
  await assert.rejects(listHarnessModels("pi"), /private-failure/);
  await performanceDiagnostics.flush();

  const log = await readFile(path.join(resolveDataDirectory(), "logs", "performance.jsonl"), "utf8");
  const lines = log.split("\n").filter(line => line.includes('"operation":"harness.'));
  for (const line of lines) t.diagnostic(line);
  const entries = lines.map(line => JSON.parse(line) as { event: string; operation: string; durationMs: number });
  assert.deepEqual(entries.map(entry => entry.operation).sort(), [
    "harness.models.claude", "harness.models.pi", "harness.readiness.claude", "harness.readiness.pi", "harness.sign_in.claude", "harness.sign_in.pi",
  ]);
  assert.ok(entries.every(entry => entry.event === "slow_operation" && entry.durationMs >= 500));
  assert.doesNotMatch(log, /private-failure/);
});
