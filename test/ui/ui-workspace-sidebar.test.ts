import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("the desktop sidebar resizes, collapses, and restores its width", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  const inbox = page.getByTestId("workspace-inbox-button");
  await inbox.click();

  const side = page.getByTestId("workspace-side");
  const toggle = page.getByTestId("workspace-sidebar-toggle");
  const resize = page.getByTestId("workspace-sidebar-resize");
  const width = async () => Math.round((await side.boundingBox())!.width);
  const start = await width();
  assert.ok(await toggle.isVisible(), "the toggle is available in Inbox");
  assert.ok(await resize.isVisible(), "the expanded sidebar has a resize separator");
  const grip = (await resize.boundingBox())!;
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y, { steps: 5 });
  assert.equal(await width(), start + 100, "the sidebar follows the pointer before release");
  await page.mouse.up();
  await resize.press("ArrowRight");
  const saved = await width();
  assert.ok(saved > start + 100, "keyboard resizing also moves the separator");

  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.ok(await width() < 80, "collapse leaves an icon rail");
  assert.ok(await inbox.isVisible(), "navigation stays available in the rail");
  assert.ok(await resize.isHidden(), "the rail cannot be resized until expanded");
  await toggle.press("Enter");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await width(), saved);

  await page.reload({ waitUntil: "domcontentloaded" });
  await inbox.click();
  assert.equal(await width(), saved, "the width survives reload");
  await page.setViewportSize({ width: 900, height: 844 });
  assert.ok(await width() < saved, "a narrower window limits the sidebar width");
  await page.setViewportSize({ width: 1740, height: 900 });
  assert.equal(await width(), saved, "widening the window restores the preferred size");
  await page.getByTestId("workspace-projects-button").click();
  assert.ok(await toggle.isVisible(), "Projects uses the same sidebar toggle");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await toggle.isHidden());
  assert.ok(await resize.isHidden());
});
