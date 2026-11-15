import assert from "node:assert/strict";
import { test } from "node:test";
import { api, signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("cluster settings save project policy and an enforced pool without editing personal assignments", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const session = await signIn(environment, node);
  const created = await api<{ snapshot: { body: { clusterId: string } } }>(node, session, "POST", "/clusters", { name: "Policy team" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const clusterId = created.body.snapshot.body.clusterId;
  const profile = await api<{ profile: { id: string } }>(node, session, "POST", "/provider-profiles", { label: "Team fixture", provider: "claude" });
  assert.equal(profile.status, 201, JSON.stringify(profile.body));
  const pool = await api<{ pool: { id: string } }>(node, session, "POST", "/provider-profiles/pools", {
    name: "Mandatory team pool", profileIds: [profile.body.profile.id], fallbackModels: {},
  });
  assert.equal(pool.status, 201, JSON.stringify(pool.body));
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-cluster").click();
  await page.getByTestId("cluster-item").filter({ hasText: "Policy team" }).click();
  await page.getByTestId("cluster-tab-policy").click();
  const panel = page.getByTestId("cluster-policy");
  await panel.getByTestId("cluster-policy-source").waitFor();
  assert.match(await panel.innerText(), /regardless of.*relay/i);
  await panel.getByTestId("cluster-policy-blocked-skills").fill("unsafe-fixture\nsecond-fixture");
  const policyResponse = page.waitForResponse(response => response.url().endsWith(`/clusters/${clusterId}/agent-policy`) && response.request().method() === "PUT");
  await panel.getByTestId("cluster-policy-save").click();
  const policyReply = await policyResponse;
  assert.equal(policyReply.status(), 200, await policyReply.text());
  await panel.getByTestId("cluster-policy-status").filter({ hasText: "Policy saved" }).waitFor();
  const saved = await api<{ policy: { policy: { rules: unknown[] } } }>(node, session, "GET", `/clusters/${clusterId}/agent-policy`);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.policy.policy.rules, [
    { action: "block", name: "unsafe-fixture", harness: "all" },
    { action: "block", name: "second-fixture", harness: "all" },
  ]);

  const choice = panel.getByTestId("cluster-policy-pool");
  const value = await choice.locator("option").filter({ hasText: "Mandatory team pool" }).getAttribute("value");
  assert.ok(value);
  await choice.selectOption(value);
  await panel.getByTestId("cluster-policy-pool-save").click();
  await panel.getByTestId("cluster-policy-pool-status").filter({ hasText: "Pool saved" }).waitFor();
  const assigned = await api<{ assignment: { poolId: string } }>(node, session, "GET", `/clusters/${clusterId}/subscription-pool`);
  assert.equal(assigned.body.assignment.poolId, pool.body.pool.id);
  const personal = await api<{ selections: unknown[] }>(node, session, "GET", "/provider-profiles");
  assert.deepEqual(personal.body.selections, [], "cluster assignment must not become a personal default");
  assert.match(await panel.innerText(), /override/i);
  assert.deepEqual(pageErrors, []);
});
