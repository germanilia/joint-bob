import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { waitInPage } from "./wait-in-page.js";

async function signedIn(t: test.TestContext) {
  const fixture = await nativeUiFixture(t);
  const { page, environment, node } = fixture;
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  await waitInPage(page, async () => (await import("/app/state.js")).state.preferencesLoaded);
  // Boot resets the view to the project list as its last step; open the control center only after that.
  await page.waitForTimeout(500);
  // With a project open the page listens for what the server announces, such as Bob's messages.
  await page.locator("#projectList .list-row").first().click();
  await waitInPage(page, async () => (await import("/app/state.js")).state.watchSocket?.readyState === 1);
  return fixture;
}


test("a secret an assistant's setup asks for is entered in its own box and sent straight to the server", { timeout: 180_000 }, async (t) => {
  const { page } = await signedIn(t);
  // Bob's message is a fixture, and the save is caught: the box, what it shows and what it sends are the real page's.
  await page.evaluate(`(() => {
    const message = {
      id: "m1", role: "bob", importance: "needs-you", via: "Assistant setup · needs a secret", projectId: null, projectName: null, createdAt: new Date().toISOString(), resolvedAt: null, resolution: null,
      text: '"Poster" needs Poster API to be set up.',
      actions: [{ id: "assistant-setup.secret", label: "Enter it", style: "primary", data: { secretRequest: { id: "11111111-1111-4111-8111-111111111111", label: "Poster API", why: "Create a token at example.test/settings/tokens", names: ["POSTER_TOKEN", "POSTER_ID"], assistantName: "Poster" } } }],
    };
    const originalFetch = window.fetch;
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    window.__sent = [];
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href).pathname;
      if (url === "/api/control-center/bob/messages") return reply({ messages: [message], waiting: 1 });
      if (url.startsWith("/api/control-center/assistant-setup/secrets/")) { window.__sent.push({ url, body: JSON.parse(String(args[1].body)) }); return reply({ saved: true }); }
      return originalFetch(...args);
    };
  })()`);
  await page.getByTestId("projects-open-control-center-button").click();
  await page.locator(".control-action", { hasText: "Enter it" }).click();

  const dialog = page.getByTestId("control-secret-dialog");
  await dialog.waitFor();
  assert.equal(await dialog.locator("h2").textContent(), "Poster needs Poster API");
  assert.equal(await page.getByTestId("control-secret-why").textContent(), "Create a token at example.test/settings/tokens");
  const inputs = page.getByTestId("control-secret-input");
  assert.equal(await inputs.count(), 2);
  assert.deepEqual(await inputs.evaluateAll((nodes) => nodes.map((node) => [(node as HTMLInputElement).type, (node as HTMLInputElement).name])), [["password", "POSTER_TOKEN"], ["password", "POSTER_ID"]]);
  await inputs.nth(0).fill("s3cret");
  await inputs.nth(1).fill("42");
  if (process.env.JOINT_BOB_UI_SHOT) await page.screenshot({ path: process.env.JOINT_BOB_UI_SHOT });
  await page.getByTestId("control-secret-save").click();
  await page.waitForFunction("window.__sent.length === 1");
  assert.deepEqual(await page.evaluate("window.__sent"), [{ url: "/api/control-center/assistant-setup/secrets/11111111-1111-4111-8111-111111111111", body: { messageId: "m1", values: { POSTER_TOKEN: "s3cret", POSTER_ID: "42" } } }]);
  assert.equal(await dialog.evaluate((node) => (node as HTMLDialogElement).open), false);
  assert.equal(await page.getByTestId("control-secret-input").count(), 0, "the values do not stay in the page");
});
