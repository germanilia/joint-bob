import assert from "node:assert/strict";
import test from "node:test";
import { api, signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("Settings opens immediately and local settings do not wait for optional panels", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  const settings = gate(), cluster = gate();
  const clusterRequested = gate();
  await page.route("**/api/settings", async route => { await settings.promise; await route.continue(); });
  await page.route("**/api/cluster/node", async route => { clusterRequested.release(); await cluster.promise; await route.continue(); });
  await page.route("**/api/update/status", route => route.fulfill({ status: 503, json: { error: "Update service unavailable" } }));
  const writes: string[] = [];
  page.on("request", request => { if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings") writes.push(request.url()); });
  try {
    await page.getByTestId("settings-open-button").click();
    await page.locator("#settingsDialog[open]").waitFor({ timeout: 2_000 });
    assert.equal(await page.locator("#settingsForm").getAttribute("data-ready"), "false");
    assert.equal(await page.getByTestId("settings-save-state").getAttribute("data-state"), "loading");
    assert.equal(await page.locator("#settingsForm").getAttribute("aria-busy"), "true");
    // An unfinished settings read must never overwrite saved values: its fields wait, and a change made anyway is not sent.
    assert.equal(await page.locator("#settingsPanel-account").evaluate(element => (element as HTMLElement).inert), true);
    await page.evaluate(() => {
      const box = document.querySelector<HTMLInputElement>("#settingsDigestAttachments")!;
      box.checked = !box.checked;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(500);
    assert.deepEqual(writes, [], "nothing is saved before the saved values are on the page");
    assert.equal(await page.getByTestId("settings-tab-cluster").isEnabled(), true, "navigation must not wait for local settings");
    await page.getByTestId("settings-tab-cluster").click();
    await page.getByTestId("cluster-loading").waitFor();
    assert.equal(await page.getByTestId("cluster-loading").evaluate(element => getComputedStyle(element, "::before").content), '""', "pending clusters show a spinner");
    assert.equal(await page.getByTestId("cluster-content").isVisible(), false);
    await clusterRequested.promise;
    await page.getByTestId("settings-cancel-button").click();
    await page.getByTestId("settings-open-button").click();
    await page.locator("#settingsDialog[open]").waitFor({ timeout: 2_000 });
    await page.getByTestId("settings-tab-cluster").click();
    settings.release();
    await page.locator('#settingsForm[data-ready="true"]').waitFor({ timeout: 5_000 });
    assert.equal(await page.getByTestId("cluster-loading").isVisible(), true, "optional cluster requests do not block saving local settings");
    assert.deepEqual(writes, [], "loading the saved values saves nothing");
    cluster.release();
    await page.getByTestId("cluster-content").waitFor({ timeout: 5_000 });
    assert.equal(await page.getByTestId("cluster-loading").isVisible(), false);
    assert.equal(await page.getByTestId("settingsPanel-cluster").evaluate(element => element.inert), false);
    assert.equal(await page.locator("#settingsDialog").evaluate((element: HTMLDialogElement) => element.open), true);
    assert.equal(await page.locator("#settingsForm").getAttribute("aria-busy"), null);
    assert.equal(await page.getByTestId("settings-tab-cluster").getAttribute("aria-selected"), "true", "late local settings must not switch tabs");
    await page.getByTestId("settings-tab-engines").click();
    await page.locator("#harnessTabs button").first().waitFor();
  } finally {
    settings.release(); cluster.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("the save line shows progress, failure, and success", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  await page.getByTestId("settings-open-button").click();
  const line = page.getByTestId("settings-save-state");
  const lineIn = (state: string) => page.locator(`[data-testid="settings-save-state"][data-state="${state}"]`);
  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  assert.equal(await line.getAttribute("data-state"), "idle");
  assert.equal(await line.innerText(), "Changes save as you make them");
  assert.equal(await page.getByTestId("settings-section-head-account").getByTestId("settings-save-state").count(), 1, "the line sits in the open section's head");
  const digest = page.getByTestId("settings-digest-attachments");
  const before = await digest.isChecked();
  const pending = gate(), requested = gate();
  let fail = true;
  await page.route("**/api/settings", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    requested.release();
    await pending.promise;
    if (fail) return route.fulfill({ status: 503, json: { error: "Save unavailable" } });
    return route.continue();
  });
  try {
    await digest.click();
    assert.ok(["pending", "saving"].includes((await line.getAttribute("data-state"))!), "a change says at once that it is not saved yet");
    await requested.promise;
    await lineIn("saving").waitFor();
    assert.equal(await line.innerText(), "Saving…");
    assert.equal(await line.locator(".settings-saved-icon").evaluate(element => getComputedStyle(element, "::before").content), '""', "saving shows a spinner");
    pending.release();
    await lineIn("failed").waitFor();
    assert.match(await line.innerText(), /^Not saved: .*Save unavailable/);
    assert.equal(await line.getAttribute("role"), "alert");
    await page.locator(".toast", { hasText: /Settings not saved: .*Save unavailable/ }).waitFor();
    assert.equal(await page.locator("#settingsDialog").evaluate((element: HTMLDialogElement) => element.open), true, "a failed save keeps Settings open");
    assert.equal(await digest.isChecked(), !before, "a failed save keeps the change on the page");
    fail = false;
    await page.getByTestId("settings-save-retry").click();
    await lineIn("saved").waitFor();
    assert.equal(await line.innerText(), "Saved");
    assert.equal(await page.getByTestId("settings-save-retry").count(), 0, "Try again goes once the save succeeds");
    assert.equal(await page.locator(".toast", { hasText: "Settings saved" }).count(), 0, "saving raises no toast");
    assert.equal(await page.locator("#settingsDialog").evaluate((element: HTMLDialogElement) => element.open), true, "saving never closes Settings");
    assert.equal(await page.evaluate(async () => (await (await fetch("/api/settings")).json()).digestAttachments), !before);
  } finally {
    pending.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("a save finishes, and Settings closes, even while the conversation refresh is stalled", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#projectList .project-card").first().click();
  await page.evaluate(async () => { const { refreshSessionsQuietly } = await import('/app/socket.js'); await refreshSessionsQuietly(); });
  await page.getByTestId("settings-open-button").click();
  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  const refresh = gate(), requested = gate();
  await page.route("**/api/projects/*/sessions", async route => {
    requested.release();
    await refresh.promise;
    await route.continue();
  });
  try {
    const saved = page.waitForResponse(response => response.url().endsWith("/api/settings") && response.request().method() === "PUT");
    await page.getByTestId("settings-digest-attachments").click();
    assert.equal((await saved).status(), 200);
    await requested.promise;
    await page.locator('[data-testid="settings-save-state"][data-state="saved"]').waitFor({ timeout: 3_000 });
    await page.getByTestId("settings-cancel-button").click();
    await page.locator("#settingsDialog[open]").waitFor({ state: "hidden", timeout: 3_000 });
  } finally {
    refresh.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("failed settings reads keep saving off and allow closing the dialog", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  await page.route("**/api/settings", route => route.fulfill({ status: 503, json: { error: "Settings temporarily unavailable" } }));
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ timeout: 2_000 });
  await page.waitForFunction(() => !document.querySelector("#settingsForm")?.hasAttribute("aria-busy"));
  assert.equal(await page.locator("#settingsForm").getAttribute("data-ready"), "false");
  const line = page.getByTestId("settings-save-state");
  assert.equal(await line.getAttribute("data-state"), "unavailable");
  assert.match(await line.innerText(), /Could not load settings/);
  assert.equal(await page.locator("#settingsPanel-account").evaluate(element => (element as HTMLElement).inert), true, "nothing can be changed, so nothing can overwrite the saved values");
  await page.locator("#cancelSettingsButton").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
});

test("Settings uses the desktop viewport and keeps navigation and actions inside small screens", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  await page.setViewportSize({ width: 2415, height: 1219 });
  await page.getByTestId("settings-open-button").click();
  await page.locator('#settingsForm[data-ready="true"]').waitFor();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const desktop = await page.locator("#settingsForm").boundingBox();
  assert.ok(desktop && desktop.width >= 1600 && desktop.height >= 950, "large screens get a substantially larger Settings workspace");
  const panel = await page.locator("#settingsPanel-account").boundingBox();
  assert.ok(panel && panel.height > 700, "panels fill the larger dialog instead of keeping the old 440px cap");
  // A phone shows the save line in a section's head, not on the section list.
  await page.getByTestId("settings-tab-account").click();
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 600 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const [form, save] = await Promise.all([page.locator("#settingsForm").boundingBox(), page.getByTestId("settings-save-state").boundingBox()]);
    assert.ok(form && form.x >= 0 && form.y >= 0 && form.x + form.width <= viewport.width && form.y + form.height <= viewport.height);
    assert.ok(save && save.x >= 0 && save.x + save.width <= viewport.width && save.y + save.height <= viewport.height, "the save line is on screen without scrolling the whole dialog");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
});

test("Cluster loading failures offer retry and selected-cluster spinners ignore stale responses", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  const create = async (name: string) => {
    const result = await api<{ snapshot: { body: { clusterId: string } } }>(node, auth, "POST", "/clusters", { name });
    assert.equal(result.status, 201);
    return result.body.snapshot.body.clusterId;
  };
  const alphaId = await create("Alpha"), betaId = await create("Beta");
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  let fail = true;
  await page.route("**/api/clusters", route => fail ? route.fulfill({ status: 503, json: { error: "Fixture unavailable" } }) : route.continue());
  const alpha = gate(), beta = gate(), settings = gate();
  await page.route("**/api/settings", async route => { await settings.promise; await route.continue(); });
  await page.route(`**/api/clusters/${alphaId}/sharing`, async route => { await alpha.promise; await route.continue(); });
  await page.route(`**/api/clusters/${betaId}/sharing`, async route => { await beta.promise; await route.continue(); });
  try {
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-cluster").click();
    await page.getByTestId("cluster-retry").waitFor();
    assert.match(await page.getByTestId("cluster-loading").innerText(), /Could not load clusters/);
    assert.equal(await page.getByTestId("cluster-loading").evaluate(element => element.classList.contains("is-loading")), false);
    assert.equal(await page.getByTestId("cluster-content").isVisible(), false);
    fail = false;
    await page.getByTestId("cluster-retry").click();
    await page.getByTestId("cluster-item").filter({ hasText: "Alpha" }).click();
    await page.getByTestId("cluster-tab-sharing").click();
    await page.locator('[data-testid="sharing-status"].is-loading').waitFor();
    await page.getByTestId("cluster-item").filter({ hasText: "Beta" }).click();
    await page.getByTestId("cluster-sharing").getByText("You share with Beta").waitFor();
    const oldResponse = page.waitForResponse(response => response.url().endsWith(`/api/clusters/${alphaId}/sharing`));
    alpha.release();
    await oldResponse;
    assert.equal(await page.getByTestId("cluster-sharing").getAttribute("aria-busy"), "true", "the old cluster must not clear the new spinner");
    assert.equal(await page.locator('[data-testid="sharing-status"].is-loading').isVisible(), true);
    beta.release();
    await page.getByTestId("sharing-save").waitFor();
    assert.equal(await page.getByTestId("cluster-sharing").getAttribute("aria-busy"), null);
    assert.equal(await page.locator('[data-testid="sharing-status"].is-loading').count(), 0);
    assert.equal(await page.getByTestId("cluster-loading").isVisible(), false);
    assert.equal(await page.locator("#settingsForm").getAttribute("data-ready"), "false", "Cluster works while local settings are still loading");
    assert.equal(await page.getByTestId("settingsPanel-cluster").evaluate(element => element.inert), false);
  } finally {
    alpha.release(); beta.release(); settings.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
