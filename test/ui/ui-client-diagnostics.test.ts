import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function signIn(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#loginDialog[open]") || document.querySelector('[data-testid="settings-open-button"]')?.getClientRects().length);
  if (await page.locator("#loginDialog[open]").count()) {
    await page.getByTestId("login-username-input").fill(username);
    await page.getByTestId("login-password-input").fill(password);
    await page.getByTestId("login-submit-button").click();
  }
  await page.getByTestId("settings-open-button").waitFor();
}

test("Settings keeps client console diagnostics across a PWA reload", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);

  await page.evaluate(() => console.warn("kiro-render-diagnostic", { messages: 5271 }));
  await page.reload();
  await page.getByTestId("settings-open-button").waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-logs").click();

  const output = page.getByTestId("settings-client-logs-output");
  await output.waitFor();
  assert.match(await output.textContent() || "", /kiro-render-diagnostic.*messages.*5271/);
  assert.match(await output.textContent() || "", /navigation=reload/);

  await page.getByTestId("settings-client-logs-clear-button").click();
  assert.match(await output.textContent() || "", /No client logs captured/);
});

test("caught API failures identify the request in the alert and survive in client logs", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.route("**/api/preferences?diagnostic=*", (route) => route.fulfill({ status: 500, json: { error: "This operation was aborted" } }));
  await page.evaluate(`(async () => {
    const { api } = await import("/app/api.js");
    const { toast } = await import("/app/shell.js");
    try { await api("/api/preferences?diagnostic=private-query", { method: "PUT", body: JSON.stringify({ privateBody: "private-body" }) }); }
    catch (error) { toast.error(error.message); }
  })()`);
  const alert = page.locator('.toast[role="alert"]').filter({ hasText: "PUT /api/preferences" });
  await alert.waitFor();
  assert.match(await alert.textContent() || "", /interrupted/);
  assert.match(await alert.textContent() || "", /check.*before.*try/i);
  assert.doesNotMatch(await alert.textContent() || "", /private-query|private-body/);
  await page.reload();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-logs").click();
  const logs = await page.getByTestId("settings-client-logs-output").textContent() || "";
  assert.match(logs, /API request failed.*PUT.*\/api\/preferences/);
  assert.match(logs, /"status":500/);
  assert.doesNotMatch(logs, /private-query|private-body/);
});

test("silent client errors show as alerts without duplicating failures or showing cancellations", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.route("**/api/preferences?background=fixture", (route) => route.fulfill({ status: 429, json: { error: "Fixture rate limit" } }));

  const requests = page.waitForResponse((response) => response.url().endsWith("/api/client-errors") && response.request().postData()?.includes("Fixture rate limit") === true);
  await page.evaluate(`(async () => {
    const { api } = await import("/app/api.js");
    await api("/api/preferences?background=fixture").catch(() => {});
  })()`);
  await page.getByRole("alert").filter({ hasText: "Fixture rate limit" }).waitFor({ timeout: 4_000 });
  await page.evaluate(`(async () => {
    const { api } = await import("/app/api.js");
    const { toast } = await import("/app/shell.js");
    await api("/api/preferences?background=fixture").catch((error) => toast.error(error.message));
    const controller = new AbortController();
    controller.abort();
    await api("/api/preferences?cancelled=fixture", { signal: controller.signal }).catch(() => {});
    console.error("Fixture console failure");
    console.error("Fixture console failure");
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("Fixture uncaught failure") }));
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: new Error("Fixture rejected promise") }));
  })()`);

  for (const text of ["Fixture rate limit", "Fixture console failure", "Fixture uncaught failure", "Fixture rejected promise"]) {
    const alert = page.locator('.toast[role="alert"]').filter({ hasText: text });
    await alert.getByTestId("toast-copy-details").waitFor({ timeout: 4_000 });
    assert.equal(await alert.count(), 1, text);
  }
  assert.equal(await page.getByRole("alert").filter({ hasText: "The request was cancelled" }).count(), 0);
  assert.equal((await requests).status(), 202);
});

test("an error alert offers its report: the failed request, its answer, no query or body", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.route("**/api/preferences?diagnostic=*", (route) => route.fulfill({ status: 409, json: { error: "Takeback request is no longer available" } }));
  await page.evaluate(`(async () => {
    const { api } = await import("/app/api.js");
    const { toast } = await import("/app/shell.js");
    try { await api("/api/preferences?diagnostic=private-query", { method: "PUT", body: JSON.stringify({ privateBody: "private-body" }) }); }
    catch (error) { toast.error(error.message); }
  })()`);
  const alert = page.locator('.toast[role="alert"]').filter({ hasText: "PUT /api/preferences" });
  await alert.waitFor();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await alert.getByTestId("toast-copy-details").click();
  await alert.getByText("Copied").waitFor();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.equal(copied.recentFailedRequests.at(-1).status, 409);
  assert.doesNotMatch(JSON.stringify(copied), /private-query|private-body/);
  const download = page.waitForEvent("download");
  await alert.getByTestId("toast-download-details").click();
  const file = await (await download).createReadStream();
  let text = "";
  for await (const chunk of file) text += chunk;
  const report = JSON.parse(text);
  assert.match(report.message, /PUT \/api\/preferences/);
  assert.equal(report.recentFailedRequests.at(-1).status, 409);
  assert.match(report.recentFailedRequests.at(-1).reason, /Takeback request is no longer available/);
  assert.doesNotMatch(text, /private-query|private-body/);
});

test("error alerts offer webhook settings without turning on delivery", { timeout: 120_000 }, async (t) => {
  const destination = "https://errors.example.invalid/hooks/fixture/synthetic-private-token";
  const { page, environment, node } = await nativeUiFixture(t, () => ({ JOINT_BOB_ERROR_WEBHOOK_URL: destination }));
  await signIn(page, node.url, environment.username, environment.password);
  await page.route("**/api/preferences?diagnostic=*", (route) => route.fulfill({ status: 502, json: { error: "Fixture gateway error" } }));
  const intake = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/client-errors" && response.request().postData()?.includes("Fixture gateway error") === true);
  await page.evaluate(`(async () => {
    const { api } = await import("/app/api.js");
    const { toast } = await import("/app/shell.js");
    try { await api("/api/preferences?diagnostic=private-query", { method: "PUT", body: '{"privateBody":"private-body"}' }); }
    catch (error) { toast.error(error.message); }
  })()`);
  const toast = page.getByRole("alert").filter({ hasText: "Fixture gateway error" });
  await toast.getByTestId("toast-error-webhook-setup").click({ timeout: 5_000 });
  const sent = await intake;
  assert.equal(sent.status(), 202);
  const payload = sent.request().postDataJSON();
  assert.ok(payload.failedRequests.some((failure: { method: string; path: string; status: number }) => failure.method === "PUT" && failure.path === "/api/preferences" && failure.status === 502));
  assert.doesNotMatch(JSON.stringify(payload), /private-query|private-body/);
  const settings = page.getByTestId("error-webhook-settings");
  await settings.getByText("https://errors.example.invalid", { exact: false }).waitFor();
  assert.equal(await page.getByTestId("error-webhook-enabled").isChecked(), false);
  assert.equal(await page.getByTestId("error-webhook-url").inputValue(), "");
  assert.doesNotMatch(await settings.innerText(), /synthetic-private-token/);
  const saved = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/error-reporting/webhook");
  await page.getByTestId("error-webhook-enabled").check();
  await page.getByTestId("error-webhook-save").click();
  assert.deepEqual(await (await saved).json(), { enabled: true, destination: "default", origin: "https://errors.example.invalid" });
  const disabled = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/error-reporting/webhook");
  await page.getByTestId("error-webhook-enabled").uncheck();
  await page.getByTestId("error-webhook-save").click();
  assert.equal((await (await disabled).json()).enabled, false);
});

test("agent switch waits for server confirmation before changing conversation identity", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  const result = await page.evaluate(`(async () => {
    const { state } = await import("/app/state.js");
    const original = { path: "/existing/pi.jsonl", id: crypto.randomUUID() };
    const sent = [];
    state.activeProjectId = "project";
    state.harnesses = [
      { id: "pi", label: "Pi", newSessionPath: "new", runtimeConfigured: true },
      { id: "kiro", label: "Kiro", newSessionPath: "kiro:new", runtimeConfigured: true },
    ];
    state.engine = "pi";
    state.activeSessionPath = original.path;
    state.activeSessionId = original.id;
    state.socket = { readyState: WebSocket.OPEN, send(value) { sent.push(value); } };
    const select = document.querySelector("#chatHarnessSelect");
    select.replaceChildren(new Option("Pi", "pi"), new Option("Kiro", "kiro"));
    select.value = "kiro";
    select.dispatchEvent(new Event("change"));
    return { path: state.activeSessionPath, id: state.activeSessionId, engine: state.engine, selected: select.value, sent };
  })()`);

  assert.deepEqual(result, {
    path: "/existing/pi.jsonl",
    id: result.id,
    engine: "pi",
    selected: "pi",
    sent: [JSON.stringify({ type: "setEngine", engine: "kiro" })],
  });
  assert.ok(result.id);
});

test("Copy logs puts the client logs on the clipboard and confirms it", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: node.url });
  await signIn(page, node.url, environment.username, environment.password);
  await page.evaluate(() => console.warn("copy-logs-diagnostic"));
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-logs").click();
  await page.getByTestId("settings-client-logs-copy-button").click();
  await page.locator(".toast").filter({ hasText: "Client logs copied" }).waitFor();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /copy-logs-diagnostic/);
});
