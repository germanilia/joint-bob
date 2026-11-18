import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("oversized replication receipts reject before allocating an issue for every item", () => {
  const result = spawnSync(process.execPath, [
    "--max-old-space-size=192", "--import", "tsx", "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { replicationReceiptSchema } from "./src/server/schemas.ts";
      const result = replicationReceiptSchema.safeParse({ received: Array(100_000).fill(0) });
      assert.equal(result.success, false);
      assert.equal(result.error.issues.length, 1, "oversized collections must stop before item validation");
      assert.equal(result.error.issues[0].code, "too_big");
      assert.deepEqual(result.error.issues[0].path, ["received"]);
    `,
  ], { encoding: "utf8", timeout: 20_000, maxBuffer: 16_384 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
});
