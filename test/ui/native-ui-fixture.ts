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
  // Bob's page shares the shell with the left column (about 300 px), so the window is that much wider: the page keeps its old room.
  const context = await browser.newContext({ viewport: { width: 1740, height: 900 }, serviceWorkers: "block" });
  context.setDefaultTimeout(20_000);
  const page = await context.newPage();
  return { page, environment, node, server };
}

/** Bob's chat floats over the page: a test that uses the board and the chat together parks it at the bottom right, off the board's buttons. */
export async function parkBobChat(page: Page) {
  await page.getByTestId("control-chat").evaluate((chat) => {
    const box = chat.getBoundingClientRect();
    chat.style.left = `${innerWidth - box.width - 8}px`;
    chat.style.top = `${innerHeight - box.height - 8}px`;
  });
}

/** Open the contextual chat window without navigating away from the view under test. */
export async function openBobChat(page: Page) {
  const visible = (testid: string) => `(() => { const node = document.querySelector('[data-testid="${testid}"]'); return Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden"); })()`;
  await page.waitForFunction(`${visible("control-chat-input")} || document.body.classList.contains("bob-chat-folded")`);
  if (!await page.getByTestId("control-chat-input").isVisible()) await page.evaluate(() => window.dispatchEvent(new CustomEvent("bob-chat-wanted")));
  await page.getByTestId("control-chat-input").waitFor({ state: "visible" });
}
