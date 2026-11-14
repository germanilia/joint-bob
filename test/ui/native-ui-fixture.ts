import type { ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { Browser, Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

// Repository UI tests only: synthetic accounts, loopback nodes, fresh Chrome context.
export async function nativeUiFixture(t: TestContext, extraEnv: (root: string) => Record<string, string> = () => ({})) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jb-ui-")));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        if (server) await stopDevNode(server);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  server = await startDevNode(environment, node, extraEnv(root));
  browser = await launchChrome({ headless: true, env: { ...process.env, HOME: environment.home } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  context.setDefaultTimeout(20_000);
  // Bob's page draws the Live agents board as a list by default; these tests were written for the cards, so they start there.
  // The list has its own test (ui-control-list.test.ts), which asks for it.
  await context.addInitScript(() => { if (!localStorage.getItem("jointBobLiveLayout")) localStorage.setItem("jointBobLiveLayout", "cards"); });
  const page = await context.newPage();
  return { page, environment, node, server };
}

/** Bob's page opens with his chat folded into the "Ask Bob" button; tests that write to the chat open it first. */
export async function openBobChat(page: Page) {
  const fab = page.getByTestId("bob-fab-chat");
  await fab.waitFor({ state: "visible" });
  await fab.click();
  await page.getByTestId("control-chat-input").waitFor({ state: "visible" });
}
