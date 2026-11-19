import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

// Settings › Browser, Secrets and Workspaces are long lists: one continuous list, drawn in chunks (app/long-scroll.js;
// .agents/knowledge/list-scrolling.md), so every row is reachable by scrolling the section, with no pager.
// Synthetic metadata only: no profile, secret value or workspace folder is created.
const LISTS = [
  { section: "browser", prefix: "browser-profile", list: "browser-profile-directory", total: 31 },
  { section: "secrets", prefix: "secret-account", list: "secret-account-list", total: 23 },
] as const;
const WORKSPACES = 95;

const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function openSection(page: Page, section: string) {
  await page.evaluate(async (name) => { await (await import("/app/settings.js")).openSettings(name); }, section);
  await page.locator(`#settingsPanel-${section}`).waitFor();
}

test("long Settings lists scroll, have no pager, and keep every row action", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const machines = [{ id: node.nodeId, name: "Mac laptop" }, { id: "11111111-1111-4111-8111-111111111111", name: "Homeserver" }];
  const profiles = Array.from({ length: 31 }, (_, index) => ({
    id: `profile-${index}`, label: `Profile ${index + 1}`, nodeId: machines[index % 2].id, nodeName: machines[index % 2].name,
    sites: index % 3 ? [`https://site-${index}.example`] : [], grants: [], canManage: index !== 2, holder: null,
  }));
  // The last account's name is found inside every other name, so revealing it must turn to the last page.
  const accounts = Array.from({ length: 23 }, (_, index) => ({
    id: `account-${index}`, label: index === 22 ? "Fixture" : `Fixture account ${index + 1}`, provider: index % 2 ? "custom" : "openai", websiteOrigin: null,
    variables: [{ name: index === 22 ? "FIXTURE_LAST_KEY" : `FIXTURE_KEY_${index + 1}`, kind: "value", configured: true }], shared: index === 1, readOnly: false, projectId: null,
  }));
  const workspaces = Array.from({ length: WORKSPACES }, (_, index) => ({ id: `fixture-${index + 1}`, label: `Fixture workspace ${index + 1}` }));
  await page.route("**/api/browser/directory", (route) => route.fulfill({ json: { profiles, unavailableNodes: [] } }));
  await page.route("**/api/browser/share-targets", (route) => route.fulfill({ json: { localNodeId: node.nodeId, nodes: machines, clusters: [], workspaces: [] } }));
  await page.route("**/api/secrets", (route) => route.request().method() === "GET" ? route.fulfill({ json: { accounts } }) : route.continue());
  await page.route("**/api/workspaces", (route) => route.request().method() === "GET" ? route.fulfill({ json: { workspaces } }) : route.continue());

  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });

  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    for (const { section, prefix, list, total } of LISTS) {
      await openSection(page, section);
      const rows = page.getByTestId(list).locator(":scope > .long-list-row");
      await rows.first().waitFor();
      assert.equal(await page.getByTestId(`${prefix}-pager`).count(), 0, `${section} has no pager`);
      assert.equal(await page.getByTestId(list).getAttribute("data-total"), String(total));
      await frames(page);
      assert.equal(await rows.count(), total, `${section} draws every row at ${width}px`);
      const geometry = await page.getByTestId(list).evaluate((element) => {
        const panel = element.closest(".settings-panel")!;
        const heights = [...element.querySelectorAll(":scope > .long-list-row")].map((row) => Math.round(row.getBoundingClientRect().height));
        return { heights: [...new Set(heights)], overflowX: panel.scrollWidth - panel.clientWidth, scrolls: panel.scrollHeight > panel.clientHeight };
      });
      assert.deepEqual(geometry.heights.length, 1, `${section} rows share one height at ${width}px: ${geometry.heights}`);
      assert.equal(geometry.overflowX <= 1, true, `${section} does not scroll sideways at ${width}px`);
      assert.equal(geometry.scrolls, true, `${section} scrolls with the section at ${width}x${height}`);
    }
  }

  // Workspaces: one continuous list. The first chunk is forty rows; scrolling the section draws the rest, and a refresh keeps the place.
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await openSection(page, "workspaces");
    const workspaceList = page.getByTestId("workspace-list");
    await workspaceList.locator(":scope > .long-list-row").first().waitFor();
    assert.equal(await page.getByTestId("workspace-pager").count(), 0, "no pager");
    assert.equal(await workspaceList.getAttribute("data-total"), String(WORKSPACES));
    // The drawn count outlives a resize (the same list), so only the first pass starts at the first chunk.
    if (width === 1440) assert.equal(await workspaceList.getAttribute("data-rendered"), "40", "the first chunk is forty rows");
    for (let step = 0; step < 4 && Number(await workspaceList.getAttribute("data-rendered")) < WORKSPACES; step++) {
      const before = Number(await workspaceList.getAttribute("data-rendered"));
      if (before >= WORKSPACES) break;
      await workspaceList.evaluate((element) => { const panel = element.closest(".settings-panel")!; panel.scrollTop = panel.scrollHeight; });
      await page.waitForFunction((count) => Number(document.querySelector('[data-testid="workspace-list"]')?.getAttribute("data-rendered")) > count, before);
    }
    assert.equal(await workspaceList.locator(":scope > .long-list-row").count(), WORKSPACES, `every workspace is reachable at ${width}px`);
    const place = await workspaceList.evaluate((element) => element.closest(".settings-panel")!.scrollTop);
    await page.evaluate(async () => { await (await import("/app/workspaces.js")).loadWorkspaces(); });
    await frames(page);
    assert.equal(await workspaceList.locator(":scope > .long-list-row").count(), WORKSPACES, "a refresh keeps every drawn row");
    assert.ok(Math.abs((await workspaceList.evaluate((element) => element.closest(".settings-panel")!.scrollTop)) - place) < 4, "a refresh keeps the place");
  }

  // On a phone a row's actions fold behind ⋯; none is dropped, and each is a full-size target.
  await openSection(page, "browser");
  const firstRow = page.getByTestId("browser-profile-directory-row").first();
  assert.equal(await firstRow.getByTestId("browser-profile-share").isVisible(), false);
  await firstRow.getByTestId("browser-profile-more").click();
  for (const action of ["browser-profile-share", "browser-profile-rename", "browser-profile-delete"]) {
    const box = (await firstRow.getByTestId(action).boundingBox())!;
    assert.ok(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= 390, `${action} is reachable on a phone: ${JSON.stringify(box)}`);
  }
  await firstRow.getByTestId("browser-profile-rename").click();
  await page.getByTestId("browser-profile-rename-input").waitFor();
  await page.getByTestId("browser-profile-rename-input").press("Escape");
  assert.equal(await page.locator("#settingsDialog").isVisible(), true, "Escape leaves the rename, not Settings");

  // The filter and the machine dropdown narrow the list.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSection(page, "browser");
  await page.getByTestId("browser-profile-machine").selectOption(machines[1].id);
  await page.waitForFunction(() => document.querySelector('[data-testid="browser-profile-directory"]')?.querySelectorAll(":scope > .long-list-row").length === 15);
  await page.getByTestId("browser-profile-filter").fill("Profile 30");
  assert.deepEqual(await page.getByTestId("browser-profile-directory-row").locator("strong").allInnerTexts(), ["Profile 30"]);

  // Settings search, from another section, reveals the row that holds an account.
  const search = page.getByTestId("settings-search-input");
  await search.fill("FIXTURE_LAST_KEY");
  await page.getByTestId("settings-search-result").getByText("Fixture", { exact: true }).click();
  const row = page.getByTestId("secret-account-list").locator('.secret-account-row[data-account-id="account-22"]');
  await row.waitFor();
  assert.ok(await row.evaluate((element) => element.classList.contains("settings-hit")));
  assert.equal(await page.getByTestId("secret-account-search").inputValue(), "Fixture");

  assert.deepEqual(errors, []);
});
