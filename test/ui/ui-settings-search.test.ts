import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("settings search finds a setting by its name, opens its section, and flashes the row", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });

  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-conversations").click();

  // One list: every group is a quiet label over all of its sections, each a row with its icon and name.
  assert.deepEqual(await page.locator(".settings-group-label").allTextContents(), ["You", "Workspace", "Agents", "Network", "This node"]);
  const rows = () => page.locator("#settingsForm .settings-tab[data-settings-tab]").evaluateAll((tabs) => tabs.filter((tab) => (tab as HTMLElement).checkVisibility()).map((tab) => {
    const box = tab.getBoundingClientRect();
    const icon = tab.querySelector(".settings-tab-icon svg path")?.getBoundingClientRect();
    return { name: tab.querySelector(".settings-tab-label")?.textContent ?? "", height: box.height, display: getComputedStyle(tab).display, icon: Boolean(icon && icon.width > 8 && (tab.querySelector(".settings-tab-icon") as HTMLElement).checkVisibility()), group: tab.closest(".settings-group")?.querySelector(".settings-group-label")?.textContent ?? "" };
  }));
  const all = await rows();
  const sections = await page.locator("#settingsForm .settings-tab[data-settings-tab]:not([hidden])").count();
  assert.equal(all.length, sections, "every section is a row in the list, whichever group is open");
  assert.ok(all.length >= 25, `the list holds every section, got ${all.length}`);
  for (const row of all) {
    assert.equal(row.display, "flex", `${row.name} is a full row, not a word in a line`);
    assert.ok(row.height >= 34 && row.height <= 36, `${row.name} is 34–36 px tall, got ${row.height}`);
    assert.ok(row.icon, `${row.name} has its icon`);
  }
  assert.deepEqual([...new Set(all.map((row) => row.group))], ["You", "Workspace", "Agents", "Network", "This node"], "all five groups show their rows");
  for (const name of ["Account", "Conversations", "Harnesses", "Cluster", "Changelog"]) assert.ok(all.some((row) => row.name === name), `${name} is in the list`);
  // The list fits a short window by scrolling under the search box, which stays where it is.
  await page.setViewportSize({ width: 1280, height: 700 });
  const searchTop = (await page.getByTestId("settings-search-input").boundingBox())?.y;
  const scroller = page.getByTestId("settings-nav-scroll");
  assert.ok(await scroller.evaluate((list) => list.scrollHeight > list.clientHeight), "the list scrolls on a 700 px tall window");
  await page.getByTestId("settings-tab-changelog").click();
  assert.ok(await scroller.evaluate((list) => list.scrollTop > 0), "the open section's row is scrolled into sight");
  const last = await page.getByTestId("settings-tab-changelog").boundingBox();
  assert.ok(last && last.y + last.height <= 700, "the last row is reachable");
  assert.equal((await page.getByTestId("settings-search-input").boundingBox())?.y, searchTop, "the search box does not scroll away");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByTestId("settings-tab-conversations").click();

  // A field name finds its setting even when another section is open.
  const search = page.getByTestId("settings-search-input");
  await search.fill("mfa");
  const results = page.getByTestId("settings-search-result");
  await results.first().waitFor({ timeout: 10_000 });
  assert.match(await results.first().textContent() ?? "", /Multi-factor authentication/);
  await results.first().click();

  assert.equal(await page.getByTestId("settings-tab-account").getAttribute("aria-selected"), "true", "the matching section opens");
  await page.locator("#settingsPanel-account .settings-hit").first().waitFor({ timeout: 10_000 });
  assert.equal(await search.inputValue(), "", "the search clears after a pick");
  assert.equal((await rows()).length, all.length, "the whole list is back after a pick");

  // Typing filters the list in place to the sections whose name matches; Enter opens the best one.
  await search.fill("harnesses");
  await page.waitForFunction(() => document.querySelector(".settings-sidebar")?.hasAttribute("data-searching"));
  assert.deepEqual((await rows()).map((row) => row.name), ["Harnesses"], "only the matching section stays in the list");
  assert.deepEqual(await page.locator(".settings-group-label").evaluateAll((labels) => labels.filter((label) => (label as HTMLElement).checkVisibility()).map((label) => label.textContent)), ["Agents"], "groups without a match leave the list");
  await search.press("Enter");
  assert.equal(await page.getByTestId("settings-tab-engines").getAttribute("aria-selected"), "true");
  assert.equal((await rows()).length, all.length, "the whole list is back");
  // A loose query keeps several sections, in the list's own order; clicking one opens it and ends the search.
  await search.fill("co");
  const loose = (await rows()).map((row) => row.name);
  assert.ok(loose.length > 1 && loose.length < all.length && loose.includes("Conversations") && loose.includes("Connections"), `"co" keeps the sections it matches, got ${loose.join(", ")}`);
  await page.getByTestId("settings-tab-connections").click();
  assert.equal(await page.getByTestId("settings-tab-connections").getAttribute("aria-selected"), "true");
  assert.equal(await search.inputValue(), "");
  assert.equal((await rows()).length, all.length);
  // The arrows walk the filtered rows and the settings found inside sections; Escape gives the list back and keeps Settings open.
  await search.fill("relay");
  await page.waitForFunction(() => document.querySelector('[data-testid="settings-tab-relay"]')?.classList.contains("active"));
  await search.press("ArrowDown");
  assert.equal(await page.getByTestId("settings-tab-relay").evaluate((tab) => tab.classList.contains("active")), false, "the arrow moves on from the section row");
  assert.equal(await results.first().evaluate((row) => row.classList.contains("active")), true, "to the first setting found inside a section");
  await search.press("ArrowUp");
  assert.equal(await page.getByTestId("settings-tab-relay").evaluate((tab) => tab.classList.contains("active")), true);
  await search.press("Escape");
  assert.equal(await search.inputValue(), "");
  assert.equal((await rows()).length, all.length);
  assert.equal(await page.locator("#settingsDialog").evaluate((dialog) => (dialog as HTMLDialogElement).open), true, "Escape in a search only ends the search");
  // With nothing typed, the arrow steps from the box into the list, where the arrows walk the sections.
  await search.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "settingsTab-connections");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.getByTestId("settings-tab-classifiers").getAttribute("aria-selected"), "true");
  // The theme is found by its name.
  await search.fill("theme");
  await results.first().waitFor();
  assert.match(await results.first().innerText(), /Theme\s+Account › Appearance/);
  await search.press("Enter");
  assert.equal(await page.getByTestId("settings-tab-account").getAttribute("aria-selected"), "true");

  // A saved account can be found by name or variable from anywhere, even when
  // the Secrets list is currently filtered to another provider.
  await page.getByTestId("settings-tab-secrets").click();
  await page.getByTestId("secret-account-add-button").click();
  await page.getByTestId("secret-account-label-input").fill("Search fixture billing");
  await page.getByTestId("secret-variable-name-input").first().fill("BILLING_SEARCH_KEY");
  await page.getByTestId("secret-variable-value-input").first().fill("synthetic-only");
  await page.getByTestId("secret-variable-value-input").nth(1).fill("synthetic-only");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/secrets/accounts") && response.request().method() === "POST");
  await page.getByTestId("secret-account-save-button").click();
  assert.equal((await created).status(), 201);
  await page.getByTestId("secret-account-dialog").waitFor({ state: "hidden" });
  await page.getByTestId("secret-type-select").click();
  await page.getByTestId("secret-type-select-search").fill("stripe");
  await page.getByTestId("secret-type-select-option").getByText("Stripe").click();
  await page.getByTestId("settings-tab-account").click();
  await search.fill("BILLING_SEARCH_KEY");
  await results.getByText("Search fixture billing").waitFor();
  await results.getByText("Search fixture billing").click();
  assert.equal(await page.getByTestId("settings-tab-secrets").getAttribute("aria-selected"), "true");
  const accountRow = page.getByTestId("secret-account-list").locator(".secret-account-row").filter({ hasText: "Search fixture billing" });
  await accountRow.waitFor();
  assert.ok(await accountRow.evaluate((row) => row.classList.contains("settings-hit")));
  assert.equal(await page.getByTestId("secret-account-search").inputValue(), "Search fixture billing");
  assert.equal(await page.getByTestId("secret-type-select").getAttribute("data-value"), "all");
  await search.fill("Search fixture billing");
  await results.getByText("Search fixture billing").waitFor();
  await search.fill("synthetic-only");
  await page.getByText("No settings match").waitFor({ timeout: 10_000 });

  // A query nothing matches says so.
  await search.fill("zqxjv");
  await page.getByText("No settings match").waitFor({ timeout: 10_000 });

  assert.deepEqual(errors, []);
});

// On a phone the same list is native rows: icon, name, chevron, 48 px, the search on top. The theme in use is
// named on an Appearance row at the top of the list, and Account opens on the six theme tiles.
test("the phone's Settings list names the theme, and Account opens on six theme tiles that work", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("phone-tab-settings").click();
  await page.locator("#settingsDialog[open]").waitFor();
  await page.locator("#settingsForm[data-ready='true']").waitFor();

  const rows = await page.locator("#settingsForm .settings-tab[data-settings-tab]").evaluateAll((tabs) => tabs.filter((tab) => (tab as HTMLElement).checkVisibility()).map((tab) => ({
    name: tab.querySelector(".settings-tab-label")?.textContent ?? "",
    height: tab.getBoundingClientRect().height,
    icon: Boolean(tab.querySelector(".settings-tab-icon svg path")),
    chevron: getComputedStyle(tab, "::after").backgroundImage !== "none",
  })));
  assert.equal(rows.length, await page.locator("#settingsForm .settings-tab[data-settings-tab]:not([hidden])").count(), "every section is a row");
  for (const row of rows) assert.ok(row.height === 48 && row.icon && row.chevron, `${row.name} is a 48 px row with an icon and a chevron: ${JSON.stringify(row)}`);
  const search = await page.getByTestId("settings-search-input").boundingBox();
  const first = await page.getByTestId("settings-appearance-link").boundingBox();
  assert.ok(search && first && search.y + search.height <= first.y, "the search box is on top of the list");

  // The Appearance row says which theme is in use and opens the tiles.
  const link = page.getByTestId("settings-appearance-link");
  assert.equal(await page.getByTestId("settings-appearance-value").innerText(), "System");
  await link.click();
  assert.equal(await page.locator("#settingsForm").getAttribute("data-mobile-view"), "panel");
  assert.equal(await page.getByTestId("settings-tab-account").getAttribute("aria-selected"), "true");
  const tiles = await page.locator('[data-testid="settings-theme-tiles"] .theme-tile').evaluateAll((items) => items.map((item) => {
    const box = item.getBoundingClientRect();
    return { name: item.textContent ?? "", left: Math.round(box.left), top: Math.round(box.top), bottom: box.bottom, width: box.width, height: box.height, chosen: item.getAttribute("aria-checked") };
  }));
  assert.deepEqual(tiles.map((tile) => tile.name), ["System", "Light", "Sepia", "Dark", "Midnight", "Graphite"]);
  assert.equal(new Set(tiles.map((tile) => tile.left)).size, 3, "three tiles to a line");
  assert.equal(new Set(tiles.map((tile) => tile.top)).size, 2, "two lines");
  for (const tile of tiles) assert.ok(tile.top > 0 && tile.bottom <= 844 && tile.width >= 88 && tile.height >= 44, `${tile.name} shows on the first screen and is large enough to tap: ${JSON.stringify(tile)}`);
  assert.deepEqual(tiles.filter((tile) => tile.chosen === "true").map((tile) => tile.name), ["System"], "the theme in use is marked");

  // Choosing one applies it, marks it, names it on the list, and it survives a reload.
  await page.getByTestId("settings-theme-sepia").click();
  // Sepia is the light theme with its own palette.
  assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.palette]), ["light", "sepia"]);
  assert.equal(await page.getByTestId("settings-theme-sepia").getAttribute("aria-checked"), "true");
  await page.getByTestId("settings-back-button").click();
  assert.equal(await page.getByTestId("settings-appearance-value").innerText(), "Sepia");
  // Searching filters the same rows in place.
  await page.getByTestId("settings-search-input").fill("git");
  await page.waitForFunction(() => document.querySelector(".settings-sidebar")?.hasAttribute("data-searching"));
  assert.equal(await page.getByTestId("settings-tab-git").isVisible(), true);
  assert.equal(await page.getByTestId("settings-tab-account").isVisible(), false);
  assert.equal(await link.isVisible(), false, "the Appearance row steps aside for a search");
  await page.getByTestId("settings-tab-git").click();
  assert.equal(await page.locator("#settingsForm").getAttribute("data-tab"), "git");
  await page.getByTestId("settings-back-button").click();
  assert.equal(await page.getByTestId("settings-tab-account").isVisible(), true, "the whole list is back");

  await page.reload();
  await page.getByTestId("phone-tab-settings").waitFor();
  assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.palette]), ["light", "sepia"], "the theme survives a reload");
  await page.getByTestId("phone-tab-settings").click();
  await page.locator("#settingsForm[data-ready='true']").waitFor();
  assert.equal(await page.getByTestId("settings-appearance-value").innerText(), "Sepia");
  assert.deepEqual(errors, []);
});
