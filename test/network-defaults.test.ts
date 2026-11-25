import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { test } from "node:test";
import { configureNetworkDefaults, MIN_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS } from "../src/network-defaults.js";

test("configureNetworkDefaults raises low Happy Eyeballs timeouts and preserves higher ones", () => {
  const original = getDefaultAutoSelectFamilyAttemptTimeout();
  try {
    for (const low of [250, 500]) {
      setDefaultAutoSelectFamilyAttemptTimeout(low);
      configureNetworkDefaults();
      assert.equal(getDefaultAutoSelectFamilyAttemptTimeout(), MIN_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS);
    }

    const higher = MIN_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS + 2_000;
    setDefaultAutoSelectFamilyAttemptTimeout(higher);
    configureNetworkDefaults();
    assert.equal(getDefaultAutoSelectFamilyAttemptTimeout(), higher);
  } finally {
    setDefaultAutoSelectFamilyAttemptTimeout(original);
  }
});

test("server and pi-worker entrypoints configure network defaults at startup", async () => {
  for (const entrypoint of ["src/server.ts", "src/pi-worker.ts"]) {
    const source = await readFile(entrypoint, "utf8");
    assert.match(source, /\bconfigureNetworkDefaults\(\);/, `${entrypoint} must invoke configureNetworkDefaults()`);
  }
});
