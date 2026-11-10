import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function poolCheck(assignments: unknown[], accountId: string | undefined) {
  const source = readFileSync(new URL("../src/provider-profiles/service.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const boundaries = {
    poolProfileContext: () => undefined,
    automationProfileContext: () => undefined,
    actingAccount: () => accountId ? { accountId } : undefined,
    asNode: (work: () => unknown) => work(),
    getProject: async () => ({ id: "project", type: "workspace" }),
    getClusterNode: async () => ({ id: "execution-node" }),
    clusterV2Database: async () => ({}),
    resolveClusterSubscriptionPools: (_db: unknown, nodeId: string, projectId: string) => {
      assert.equal(nodeId, "execution-node");
      assert.equal(projectId, "project");
      return assignments;
    },
    projectClusterIds: () => [],
    resolveSubscriptionChoice: () => undefined,
  };
  const exports: any = {};
  vm.runInThisContext(`(function(require, exports) { ${compiled}\n})`)((name: string) => name.startsWith("node:") ? require(name) : boundaries, exports);
  return exports.piTurnsOnPool("project", "conversation") as Promise<boolean>;
}

for (const accountId of ["person", undefined]) {
  test(`Pi startup recognizes the execution node's cluster pool with account ${accountId}`, async () => {
    assert.equal(await poolCheck([{ poolId: "destination-default" }], accountId), true);
  });
}

test("Pi startup without a configured pool does not skip authentication", async () => {
  assert.equal(await poolCheck([], "person"), false);
});
