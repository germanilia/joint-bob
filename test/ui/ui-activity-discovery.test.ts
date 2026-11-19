// Regression coverage for hidden steps, tucked marker navigation and the direct btw tab.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("steps and btw are discoverable and markers reveal steps from other panes", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-activity-discovery-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  const browser = await launchChrome({ headless: true, env: { ...process.env, HOME: environment.home } });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => { pageErrors.push(error.message); console.error(error.message); });
    page.setDefaultTimeout(15_000);
    await page.addInitScript(() => localStorage.setItem("joint-bob-start-view", "last"));
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.locator("#loginDialog[open]").waitFor();
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator("#loginDialog[open]").waitFor({ state: "detached" });
    await page.getByTestId("workspace-projects-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.locator(".session-card").first().click();
    await page.locator("body.view-chat").waitFor();
    await page.locator("#messages .message.assistant").first().waitFor();
    if (!(await page.getByTestId("activity-panel").isVisible())) await page.getByTestId("chat-activity-toggle").click();
    // Use the real rendering entry points to feed a running tool, without a paid agent turn.
    await page.evaluate(async () => {
      // @ts-expect-error browser module URL
      const activity = await import("/app/activity-panel.js");
      const group = activity.startActivityGroup((marker: HTMLElement) => document.querySelector("#messages")!.append(marker), new Date(), "Inspect running action");
      const tool = document.createElement("div");
      tool.className = "tool-output";
      tool.dataset.status = "running";
      tool.innerHTML = '<span class="tool-name">Read</span><div>Running action fixture</div>';
      activity.appendToActivityGroup(group, tool);
      group.marker.dataset.testid = "discovery-marker";
      group.section.dataset.testid = "discovery-group";
    });

    await t.test("running steps show before the overview without expanding anything", async () => {
      assert.equal(await page.getByTestId("activity-list").isVisible(), true);
      assert.equal(await page.getByTestId("activity-steps-toggle").getAttribute("aria-expanded"), "true");
      assert.equal(await page.getByTestId("activity-body").evaluate((body) => {
        const list = body.querySelector("#activityList")!;
        const overview = body.querySelector("#activityOverview")!;
        return Boolean(list.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING);
      }), true, "steps precede the long overview");
    });

    await t.test("Ask opens directly and Story stays unselected", async () => {
      const tab = page.getByTestId("activity-chat-tab");
      assert.equal(await tab.isVisible(), true);
      assert.equal(await tab.innerText(), "Ask");
      await tab.click();
      await page.getByTestId("conversation-chat").waitFor();
      assert.equal(await page.getByTestId("details-story-tab").getAttribute("aria-selected"), "false");
    });

    await t.test("a marker reveals steps even when the details were tucked with another pane open", async () => {
      await page.getByTestId("details-story-tab").click();
      await page.evaluate(() => document.body.classList.add("ws-details-tucked"));
      await page.getByTestId("discovery-marker").click();
      await page.getByTestId("activity-list").waitFor();
      assert.equal(await page.getByTestId("details-story").isVisible(), false);
      assert.equal(await page.locator("body.ws-details-tucked").count(), 0);
      const inView = await page.getByTestId("discovery-group").evaluate((group) => {
        const box = group.getBoundingClientRect();
        const panel = document.querySelector("#activityPanel")!.getBoundingClientRect();
        return box.top >= panel.top && box.bottom <= panel.bottom && box.height > 0;
      });
      assert.equal(inView, true, "clicked steps are on screen");
    });
    assert.deepEqual(pageErrors, [], "no browser runtime errors");
  } finally {
    await browser.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
