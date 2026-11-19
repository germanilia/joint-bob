import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Changing a skill's harness keeps the place in the Resources list", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-activation-paging-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    for (let index = 1; index <= 30; index += 1) {
      const name = `activation-paging-${String(index).padStart(2, "0")}`;
      const folder = path.join(environment.home, "JointBob/.agent-resources/shared/skills", name);
      await mkdir(folder, { recursive: true });
      const description = index > 12 ? "Longer descriptions make later pages scroll. ".repeat(30) : "Short description.";
      await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
    }
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-resources").click();
    await page.getByTestId("resources-search-input").fill("activation-paging");
    const rows = page.getByTestId("resources-skill-row");
    await rows.first().getByTestId("resources-activation-toggle").first().waitFor();
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await settle();
    assert.equal(await page.getByTestId("resources-list-pager").isVisible(), false, "no pager");
    assert.equal(await rows.count(), 30, "every skill is in the one list");
    const panel = page.getByTestId("resources-panel");
    // Start low in the list, on the long rows.
    const lastName = await rows.last().locator("strong").textContent();
    const lastToggle = page.getByRole("checkbox", { name: `Disable ${lastName} for Pi`, exact: true });
    await lastToggle.scrollIntoViewIfNeeded();
    await settle();
    const scrollBefore = await panel.evaluate((element) => element.scrollTop);
    assert.ok(scrollBefore > 0, `precondition: the list is scrolled to its last row: ${scrollBefore}`);
    await lastToggle.uncheck();
    await page.getByTestId("resources-status").getByText(`${lastName} disabled for Pi.`, { exact: false }).waitFor();
    await settle();
    assert.equal(await rows.count(), 30, "disabling a harness keeps every row");
    assert.equal(await panel.evaluate((element) => element.scrollTop), scrollBefore, "editing a harness keeps the place in the list");
    assert.equal(await page.getByRole("checkbox", { name: `Enable ${lastName} for Pi`, exact: true }).isChecked(), false);
    const lastRow = rows.filter({ has: page.locator("strong", { hasText: lastName! }) });
    await lastRow.getByTestId("resources-activation-reset").click();
    await page.getByTestId("resources-status").getByText(`${lastName} uses the default for Pi.`, { exact: false }).waitFor();
    await settle();
    assert.equal(await panel.evaluate((element) => element.scrollTop), scrollBefore, "resetting a harness keeps the place in the list");
    assert.equal(await page.getByRole("checkbox", { name: `Disable ${lastName} for Pi`, exact: true }).isChecked(), true);
    await page.getByTestId("resources-refresh-button").click();
    await page.getByRole("checkbox", { name: `Disable ${lastName} for Pi`, exact: true }).waitFor();
    await settle();
    assert.equal(await rows.count(), 30, "refreshing keeps every row");
    await page.getByTestId("resources-search-input").fill(lastName!);
    await settle();
    assert.equal(await rows.count(), 1, "the search narrows the list");
    assert.equal(await rows.locator("strong").textContent(), lastName);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

// Wrapped descriptions give rows different heights; the one list must still hold every skill.
test("Resources list holds every skill when rows have different heights", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-paging-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const names = Array.from({ length: 30 }, (_, index) => `paging-skill-${String(index + 1).padStart(2, "0")}`);
    for (const [index, name] of names.entries()) {
      const folder = path.join(environment.home, "JointBob/.agent-resources/shared/skills", name);
      await mkdir(folder, { recursive: true });
      const description = index % 4 === 0 ? `${"Wraps across several lines of the list. ".repeat(40)}End.` : "Short description.";
      await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
    }
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-resources").click();
    await page.getByTestId("resources-search-input").fill("paging-skill");
    const rows = page.getByTestId("resources-skill-row");
    await rows.filter({ hasText: names[0] }).waitFor();
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await settle();
    assert.equal(await page.getByTestId("resources-list-pager").isVisible(), false, "no pager");
    const seen = await rows.locator("strong").allTextContents();
    assert.deepEqual([...seen].sort(), names, "every skill is in the one list, whatever its row height");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
