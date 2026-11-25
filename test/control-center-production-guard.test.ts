import assert from "node:assert/strict";
import test from "node:test";
import { guardianSettingsSchema, DEFAULT_GUARDIAN_SETTINGS } from "../src/guardian/rules.js";
import { PRODUCTION_RULE, PRODUCTION_RULE_ID, productionGuardStatus, withProductionGuard } from "../src/guardian/production-rule.js";

test("the severe-action rule blocks and turning it on keeps the other rules", () => {
  const off = structuredClone(DEFAULT_GUARDIAN_SETTINGS);
  assert.equal(productionGuardStatus(off), "guardian-off");
  assert.equal(productionGuardStatus({ ...off, enabled: true }), "on", "enabling Guardian with its default severe-action rule counts as protection");
  assert.equal(productionGuardStatus({ ...off, enabled: true, rules: off.rules.filter((rule) => rule.id !== "dangerous-commands") }), "rule-missing");
  assert.equal(productionGuardStatus({ ...off, enabled: true, rules: off.rules.map((rule) => rule.id === "dangerous-commands" ? { ...rule, enabled: false } : rule) }), "rule-off");
  const on = withProductionGuard(off);
  assert.doesNotThrow(() => guardianSettingsSchema.parse(on));
  assert.equal(productionGuardStatus(on), "on");
  assert.deepEqual(on.rules.map((rule) => rule.id).sort(), [...off.rules.map((rule) => rule.id), PRODUCTION_RULE_ID].sort());
  assert.equal(PRODUCTION_RULE.ifYes, "block");
  assert.deepEqual(withProductionGuard(on), on, "turning it on twice changes nothing");
  assert.equal(productionGuardStatus({ ...on, rules: on.rules.map((rule) => (rule.id === PRODUCTION_RULE_ID || rule.id === "dangerous-commands") ? { ...rule, enabled: false } : rule) }), "rule-off");
  assert.equal(productionGuardStatus({ ...on, rules: on.rules.filter((rule) => rule.id === PRODUCTION_RULE_ID).map((rule) => ({ ...rule, ifYes: "ask" as const })) }), "on", "a customized rule that asks still counts as protection");
});
