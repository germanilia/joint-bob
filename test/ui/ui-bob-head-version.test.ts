// Bob's page shows the release number under the Bob logo, top left.
//
// Run with `npm run test:file -- test/ui/ui-bob-head-version.test.ts`.
import assert from "node:assert/strict";
import test from "node:test";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Bob's page shows the release number under the logo", { timeout: 300_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(node.url);
  await page.waitForFunction(() => !document.body.classList.contains("booting"));
  await page.getByTestId("projects-open-control-center-button").click();
  await page.locator("body.bob-desk.view-control").waitFor();
  const version = page.getByTestId("bob-head-version");
  await version.waitFor({ state: "visible" });
  assert.match(await version.textContent() ?? "", /^v\d+\.\d+\.\d+$/);
  const logo = await page.locator(".bob-head-avatar").boundingBox();
  const label = await version.boundingBox();
  assert.ok(logo && label && label.y >= logo.y + logo.height - 1, "the version sits below the logo");
});
