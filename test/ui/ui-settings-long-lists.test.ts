import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

// Settings › Browser, Secrets and Workspaces are long lists: rows of one height that fit the
// window and page with Previous / "1–8 of 31" / Next, never growing the section.
// Synthetic metadata only: no profile, secret value or workspace folder is created.
const LISTS = [
  { section: "browser", prefix: "browser-profile", list: "browser-profile-directory", total: 31 },
  { section: "secrets", prefix: "secret-account", list: "secret-account-list", total: 23 },
  { section: "workspaces", prefix: "workspace", list: "workspace-list", total: 17 },
] as const;

const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function openSection(page: Page, section: string) {
  await page.evaluate(async (name) => { await (await import("/app/settings.js")).openSettings(name); }, section);
  await page.locator(`#settingsPanel-${section}`).waitFor();
}

test("long Settings lists fit the window, page, and keep every row action", { timeout: 180_000 }, async (t) => {
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
  const workspaces = Array.from({ length: 17 }, (_, index) => ({ id: `fixture-${index + 1}`, label: `Fixture workspace ${index + 1}` }));
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
      const label = page.getByTestId(`${prefix}-page-label`);
      await page.waitForFunction(({ id, count }) => new RegExp(`^1–\\d+ of ${count}$`).test(document.querySelector(`[data-testid="${id}"]`)?.textContent ?? ""), { id: `${prefix}-page-label`, count: total });
      await frames(page);
      const shown = Number((await label.innerText()).match(/^1–(\d+)/)![1]);
      assert.ok(shown >= 3 && shown < total, `${section} at ${width}px shows several rows and pages: ${shown}`);
      const rows = page.getByTestId(list).locator(":scope > .long-list-row");
      assert.equal(await rows.count(), shown, `${section} draws one page of rows`);
      const geometry = await page.getByTestId(list).evaluate((element, pager) => {
        const panel = element.closest(".settings-panel")!;
        panel.scrollTop = 0;
        const box = panel.getBoundingClientRect(), bar = document.querySelector(`[data-testid="${pager}"]`)!.getBoundingClientRect();
        const heights = [...element.querySelectorAll(":scope > .long-list-row")].map((row) => Math.round(row.getBoundingClientRect().height));
        return { listBottom: element.getBoundingClientRect().bottom, pagerBottom: bar.bottom, panelBottom: box.bottom, heights: [...new Set(heights)], overflowX: panel.scrollWidth - panel.clientWidth };
      }, `${prefix}-pager`);
      assert.deepEqual(geometry.heights.length, 1, `${section} rows share one height at ${width}px: ${geometry.heights}`);
      assert.ok(geometry.listBottom <= geometry.panelBottom && geometry.pagerBottom <= geometry.panelBottom, `${section} list and pager stay inside the section at ${width}x${height}: ${JSON.stringify(geometry)}`);
      assert.equal(geometry.overflowX <= 1, true, `${section} does not scroll sideways at ${width}px`);
      assert.equal(await page.getByTestId(`${prefix}-page-previous`).isDisabled(), true);
      await page.getByTestId(`${prefix}-page-next`).click();
      assert.equal(await label.innerText(), `${shown + 1}–${Math.min(total, shown * 2)} of ${total}`, `${section} Next turns the page`);
      await page.getByTestId(`${prefix}-page-previous`).click();
      assert.equal(await label.innerText(), `1–${shown} of ${total}`);
    }
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

  // The filter and the machine dropdown narrow the list and start on its first page.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSection(page, "browser");
  await page.getByTestId("browser-profile-page-next").click();
  await page.getByTestId("browser-profile-machine").selectOption(machines[1].id);
  await page.waitForFunction(() => /^1–\d+ of 15$/.test(document.querySelector('[data-testid="browser-profile-page-label"]')?.textContent ?? ""));
  await page.getByTestId("browser-profile-filter").fill("Profile 30");
  assert.deepEqual(await page.getByTestId("browser-profile-directory-row").locator("strong").allInnerTexts(), ["Profile 30"]);
  assert.equal(await page.getByTestId("browser-profile-pager").isVisible(), false, "one page needs no pager");

  // Settings search, from another section, opens the page that holds an account, wherever the list was
  // (it was last measured on the phone, so it refits as it opens).
  const search = page.getByTestId("settings-search-input");
  await search.fill("FIXTURE_LAST_KEY");
  await page.getByTestId("settings-search-result").getByText("Fixture", { exact: true }).click();
  const row = page.getByTestId("secret-account-list").locator('.secret-account-row[data-account-id="account-22"]');
  await row.waitFor();
  assert.ok(await row.evaluate((element) => element.classList.contains("settings-hit")));
  assert.equal(await page.getByTestId("secret-account-search").inputValue(), "Fixture");
  assert.match(await page.getByTestId("secret-account-page-label").innerText(), /^\d+–23 of 23$/, "the last page shows");
  assert.doesNotMatch(await page.getByTestId("secret-account-page-label").innerText(), /^1–/);

  assert.deepEqual(errors, []);
});
