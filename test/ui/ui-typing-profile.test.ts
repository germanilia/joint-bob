import assert from "node:assert/strict";
import test from "node:test";
import { webkit } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("typing in a long transcript only resizes the composer when needed", { timeout: 120_000 }, async t => {
  const fixture = await nativeUiFixture(t);
  const { environment, node } = fixture;
  const executablePath = process.env.JOINT_BOB_TEST_WEBKIT_EXECUTABLE;
  const browser = executablePath ? await webkit.launch({ headless: true, executablePath, env: { ...process.env, HOME: environment.home } }) : undefined;
  if (browser) t.after(() => browser.close());
  const page = browser ? await browser.newPage({ viewport: { width: 1440, height: 900 } }) : fixture.page;
  await page.addInitScript(() => {
    localStorage.setItem("joint-bob-start-view", "last");
    localStorage.setItem("joint-bob-workspace-column", "projects");
  });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().waitFor();
  // Use the app renderer with synthetic messages; no provider session is needed.
  await page.evaluate(async () => {
    const layoutPath = "/app/layout.js";
    const controlsPath = "/app/chat-controls.js";
    const { setMobileView } = await import(layoutPath);
    const { setComposerEnabled } = await import(controlsPath);
    setMobileView("chat");
    setComposerEnabled(true);
  });
  const input = page.getByTestId("chat-message-input");
  await input.waitFor({ state: "visible" });
  const results = await page.evaluate(async () => {
    const modulePath = "/app/chat-transcript.js";
    const { rerenderChatTranscript } = await import(modulePath);
    const input = document.querySelector<HTMLTextAreaElement>("#messageInput")!;
    const output = [];
    for (const count of [10, 350]) {
      const text = "A synthetic paragraph with **formatting** and `code` for layout measurement. ".repeat(75);
      rerenderChatTranscript(Array.from({ length: count }, (_, i) => ({ id: `profile-${i}`, role: i % 2 ? "assistant" : "user", text })), [], null);
      input.value = "A multiline draft for typing measurements. ".repeat(8);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const samples = [];
      for (let i = 0; i < 60; i++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        input.value += "x";
        const start = performance.now();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      output.push({ count, characters: count * text.length, median: samples[30], p95: samples[57], max: samples[59] });
    }
    input.value = "A stable draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const observer = new MutationObserver(() => {});
    observer.observe(input, { attributes: true, attributeFilter: ["style"] });
    input.value += "x";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const styleMutations = observer.takeRecords().length;
    observer.disconnect();
    return { styleMutations, input: output };
  });
  console.log("TYPING_PROFILE", JSON.stringify(results));
  assert.equal(results.styleMutations, 0, "typing without a new line must not resize the visible composer even temporarily");
  await input.fill("Short draft");
  const short = await input.evaluate(el => el.clientHeight);
  await input.fill("A draft long enough to wrap in the composer. ".repeat(5));
  const wrapped = await input.evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight }));
  assert.ok(wrapped.height > short, "wrapped drafts grow");
  assert.ok(wrapped.content <= wrapped.height + 1, "wrapped drafts fit");
  await input.fill("Long line\n".repeat(40));
  assert.equal(await input.evaluate(el => getComputedStyle(el).overflowY), "auto");
  await input.fill("");
  assert.equal(await input.evaluate(el => el.clientHeight), short, "the composer shrinks after clearing");
});
