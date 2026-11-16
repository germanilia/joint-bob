import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../../src/types.js";
import { api, signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("mobile Add secret searches existing accounts and attaches only to the open conversation", { timeout: 120_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  const project = node.projects[0];
  const sessions = await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`);
  const source = sessions.body.sessions.find(item => item.title === "Short one")!;
  const create = async (label: string, projectId?: string, provider = "custom") => {
    const result = await api<{ account: { id: string } }>(node, auth, "POST", "/secrets/accounts", {
      label, projectId, provider, variables: [{ name: provider === "openai" ? "OPENAI_API_KEY" : "TEST_SECRET", kind: "value", value: "synthetic" }],
    });
    assert.equal(result.status, 201);
    return result.body.account.id;
  };
  const existing = await create("Already attached");
  const added = await create("Project deployment", project.id);
  await create("Other project", node.projects[1].id);
  await create("Global account", undefined, "openai");
  const projectScopeBefore = (await api(node, auth, "GET", `/secrets/scopes/project/${project.id}`)).body.accountIds;
  const scopeUrl = `/secrets/scopes/conversation/${encodeURIComponent(`${source.harnessId}:${source.id}`)}`;
  await api(node, auth, "PUT", scopeUrl, { accountIds: [existing] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).click();
  // The list shows titles in title case; the stored title above stays "Short one".
  await page.getByText("Short One", { exact: true }).click();
  await page.getByTestId("focus-controls-button").click();
  await page.getByTestId("focus-add-secret").click();
  assert.equal(await page.locator("#secretAccountDialog").isVisible(), false, "does not open account creation");
  const dialog = page.getByTestId("conversation-secret-dialog");
  await dialog.waitFor();
  const picker = page.getByTestId("conversation-secret");
  await picker.click();
  const options = page.getByTestId("conversation-secret-option");
  assert.deepEqual((await options.allTextContents()).sort(), ["Global account", "Project deployment"].sort());
  const badges = options.getByTestId("conversation-secret-provider-badge");
  assert.equal(await badges.count(), 2, "each secret has a provider icon");
  assert.equal(await badges.first().isVisible(), true);
  assert.equal(await options.filter({ hasText: "Global account" }).locator(".secret-provider-icon.openai").count(), 1);
  const aligned = await options.first().evaluate(row => {
    const badge = row.querySelector(".secret-provider-badge")!.getBoundingClientRect();
    const label = row.querySelector(".searchable-select-option-label")!.getBoundingClientRect();
    return badge.right <= label.left && Math.abs(badge.y + badge.height / 2 - label.y - label.height / 2) < 2;
  });
  assert.equal(aligned, true, "the icon sits beside the secret name, not above it");
  const search = page.getByTestId("conversation-secret-search");
  assert.equal(await search.isVisible(), true);
  assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "conversation-secret-search", "opening the mobile list leaves the keyboard down");
  for (const query of ["openai", "OPENAI_API_KEY"]) {
    await search.fill(query);
    assert.deepEqual(await options.allTextContents(), ["Global account"], `search matches ${query}`);
    assert.equal(await options.locator(".secret-provider-icon.openai").count(), 1, "filtering keeps the matching icon");
  }
  await search.fill("no-such-secret");
  assert.equal(await options.count(), 0);
  assert.equal(await page.getByTestId("conversation-secret-options").textContent(), "No available secrets");
  await search.fill("deployment");
  assert.equal(await options.count(), 1);
  await options.click();
  assert.equal(await picker.getByTestId("conversation-secret-provider-badge").isVisible(), true, "the selected secret keeps its icon");
  await page.getByTestId("conversation-secret-cancel").click();
  assert.deepEqual((await api(node, auth, "GET", scopeUrl)).body.accountIds, [existing]);
  await page.getByTestId("focus-controls-button").click();
  await page.getByTestId("focus-add-secret").click();
  await picker.click();
  await page.getByTestId("conversation-secret-search").fill("deployment");
  await options.click();
  await page.getByTestId("conversation-secret-save").click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual((await api(node, auth, "GET", scopeUrl)).body.accountIds.sort(), [existing, added].sort());
  assert.deepEqual((await api(node, auth, "GET", `/secrets/scopes/project/${project.id}`)).body.accountIds, projectScopeBefore);
  assert.equal((await api<{ accounts: unknown[] }>(node, auth, "GET", "/secrets")).body.accounts.length, 4, "no secret account was created");
});
