import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("manager transfers administration from member row without recipient confirmation", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const other = await seedDevEnvironment(path.join(environment.home, "successor"), 1);
  const successor = other.nodes[0];
  const server = await startDevNode(other, successor);
  t.after(() => stopDevNode(server));
  const session = await signIn(environment, node), successorSession = await signIn(other, successor);
  const created = await api<{ snapshot: { body: { clusterId: string } } }>(node, session, "POST", "/clusters", { name: "Transfer team" });
  assert.equal(created.status, 201);
  const id = created.body.snapshot.body.clusterId;
  const invitation = await api<{ link: string }>(node, session, "POST", `/clusters/${id}/invitations`, { expectedEpoch: 1 });
  assert.equal((await api(successor, successorSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  async function openCluster() {
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-cluster").click();
    await page.getByTestId("cluster-item").filter({ hasText: "Transfer team" }).click();
  }
  await openCluster();
  const transfer = page.getByTestId(`cluster-transfer-manager-${successor.nodeId}`);
  await transfer.click();
  assert.match(await page.getByTestId("confirm-dialog").innerText(), /regular member/);
  await page.getByTestId("confirm-cancel-button").click();
  assert.equal((await api<{ clusters: Array<{ id: string; managerNodeId: string }> }>(node, session, "GET", "/clusters")).body.clusters.find(c => c.id === id)!.managerNodeId, node.nodeId);
  await transfer.click();
  const requested = page.waitForResponse(r => r.url().endsWith(`/clusters/${id}/manager-transfer`) && r.request().method() === "POST");
  await page.getByTestId("confirm-accept-button").click();
  assert.equal((await requested).status(), 202);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = await api<{ clusters: Array<{ id: string; managerNodeId: string }> }>(node, session, "GET", "/clusters");
    if (status.body.clusters.find(c => c.id === id)?.managerNodeId === successor.nodeId) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await api<{ clusters: Array<{ id: string; managerNodeId: string }> }>(node, session, "GET", "/clusters")).body.clusters.find(c => c.id === id)!.managerNodeId, successor.nodeId);
  await page.reload();
  await openCluster();
  await page.locator('#settingsPanel-cluster[aria-busy]').waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("cluster-delete-button").count(), 0, await page.locator("#clusterDetails").innerText());
  assert.equal(await page.locator('[data-testid^="cluster-transfer-manager-"]').count(), 0);
  assert.equal(await page.getByTestId("cluster-leave-button").isEnabled(), true);
});
