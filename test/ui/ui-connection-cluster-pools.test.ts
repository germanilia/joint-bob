import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Connections show inherited cluster pools and count their provider coverage", { timeout: 120_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  const clusterId = await page.evaluate(async () => {
    const { api } = await import("/app/api.js");
    const { profile } = await api("/api/provider-profiles", { method: "POST", body: JSON.stringify({ provider: "openai-codex", label: "Cluster Codex fixture" }) });
    const { pool } = await api("/api/provider-profiles/pools", { method: "POST", body: JSON.stringify({ name: "Contigos pool fixture", profileIds: [profile.id], fallbackModels: {} }) });
    const { snapshot } = await api("/api/clusters", { method: "POST", body: JSON.stringify({ name: "Contigos fixture" }) });
    // This path creates only a shared rule, with no personal assignment row.
    await api(`/api/clusters/${snapshot.body.clusterId}/subscription-pool`, { method: "POST", body: JSON.stringify({ poolId: pool.id, expectedEpoch: 1 }) });
    return snapshot.body.clusterId;
  });
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-connections").click();
  await page.getByTestId("provider-profiles-tab-assignments").click();
  const tab = page.getByTestId("provider-assignment-provider-openai-codex");
  assert.equal(await tab.locator(".profile-tab-count").innerText(), "1", "a shared pool counts as an assignment for its providers");
  const row = page.getByTestId("pool-assignment-row").filter({ hasText: "Contigos fixture" });
  await row.waitFor();
  assert.match(await row.innerText(), /Contigos pool fixture/);
  assert.equal(await row.locator(".invalid").count(), 0, "an inherited pool does not need a local profile to be usable");
  assert.match(await page.getByTestId("provider-assignment-cluster-note").innerText(), /every.*member/i);
  await tab.click();
  await row.getByTestId("pool-assignment-remove").click();
  await page.getByTestId("confirm-accept-button").click();
  await row.waitFor({ state: "detached" });
  const state = await page.evaluate(async id => {
    const { api } = await import("/app/api.js");
    return api(`/api/clusters/${id}/subscription-pool`);
  }, clusterId);
  assert.equal(state.assignment, null);
});
