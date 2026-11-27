import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("MCP setup names all supported harnesses and exposes shared servers to them without leaking header values", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-ui-")); let server: ChildProcess | undefined, browser;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    server = await startDevNode(environment, node); browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, serviceWorkers: "block" }), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(node.url); await page.getByTestId("login-username-input").fill(environment.username); await page.getByTestId("login-password-input").fill(environment.password); await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-resources").click();
    await page.locator("#resourcesAutoActivate:enabled").waitFor({ timeout: 10_000 }).catch(async error => {
      throw new Error(`Resources did not load: ${await page.getByTestId("resources-status").textContent()} (page errors: ${errors.join("; ")})`, { cause: error });
    });
    await page.getByTestId("resources-tab-mcp").click();
    await page.getByTestId("managed-mcp-add").click();
    const setup = page.getByTestId("managed-mcp-setup");
    const shared = setup.getByTestId("managed-mcp-auth-mode").locator('option[value="shared"]');
    for (const harness of ["Pi", "Claude", "Kiro", "Google Antigravity"]) {
      assert.ok((await shared.innerText()).includes(harness), `Shared connection option must name ${harness}`);
      assert.ok((await setup.locator("form p").innerText()).includes(harness), `MCP setup help must name ${harness}`);
    }
    await page.getByTestId("managed-mcp-json").fill(JSON.stringify({ mcpServers: { figma: { url: "http://127.0.0.1:1/figma", headers: { "X-Fixture": "synthetic-private-header" } }, docs: { url: "http://127.0.0.1:1/docs" } } }));
    await page.getByRole("button", { name: "Install shared connection" }).click(); await page.getByTestId("confirm-accept-button").click();
    const figma = page.getByTestId("resources-mcp-row").filter({ hasText: "figma" });
    await figma.waitFor(); await figma.getByTestId("managed-mcp-sign-in").waitFor();
    await page.getByTestId("resources-mcp-row").filter({ hasText: "docs" }).waitFor();
    assert.doesNotMatch(await page.getByTestId("resources-panel").innerText(), /synthetic-private-header/);
    assert.equal(await page.getByTestId("resources-list").getByText(/Pi does not load MCP servers/).count(), 0);
    for (const harness of ["pi", "claude", "kiro", "antigravity"]) {
      await page.getByTestId("resources-harness-select").selectOption(harness);
      await figma.waitFor(); await figma.getByTestId("managed-mcp-sign-in").waitFor();
    }
    await figma.getByTestId("managed-mcp-remove").click(); await page.getByTestId("confirm-accept-button").click();
    await figma.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
