import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function openInbox(t: Parameters<typeof nativeUiFixture>[0]) {
  const { page, environment, node } = await nativeUiFixture(t);
  const projects = node.projects.map(({ id, name }) => ({ id, name }));
  const card = (id: string, project: number, title: string) => ({
    projectId: projects[project].id, projectName: projects[project].name, conversationId: id, sessionId: id,
    path: `/${id}`, harnessId: "pi", title, updatedAt: "2026-11-18T12:00:00Z", pendingReviews: [],
  });
  await page.route(/\/api\/control-center\/board(?:\?|$)/, (route) => route.fulfill({ json: {
    projects,
    cards: [
      { ...card("need-1", 0, "First check"), column: "needs-you" },
      { ...card("need-2", 1, "Another check"), column: "needs-you" },
      { ...card("snoozed-1", 0, "Check tomorrow"), column: "snoozed" },
    ],
    earlier: [{ ...card("scheduled-1", 0, "Nightly report"), scheduled: true }, card("earlier-1", 0, "Old report")],
  } }));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("workspace-group-count-scheduled").getByText("1", { exact: true }).waitFor();
  return { page, project: projects[0].name };
}

test("a sidebar section keeps its count and Show all when collapsed, including after reload", { timeout: 90_000 }, async (t) => {
  const { page } = await openInbox(t);
  const scheduled = page.getByTestId("workspace-group-scheduled");
  const toggle = scheduled.getByRole("button", { name: "Scheduled 1", exact: true });
  const rows = scheduled.getByTestId("workspace-group-row");
  const earlier = page.getByTestId("workspace-group-earlier").getByText("Old report");
  await rows.getByText("Nightly report").waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded", { timeout: 2_000 }), "true");
  await toggle.press("Enter");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await rows.count(), 0);
  assert.equal(await earlier.isVisible(), true);
  await page.reload();
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await rows.count(), 0);
  await scheduled.getByTestId("workspace-show-all-scheduled").click();
  await page.getByTestId("workspace-group-page-row").getByText("Nightly report").waitFor();
  await toggle.click();
  await rows.first().waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
});

test("a narrow sidebar keeps the filtered Needs you heading and actions above the first row", { timeout: 90_000 }, async (t) => {
  const { page, project } = await openInbox(t);
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.getByTestId("workspace-groups").evaluate((groups) => groups.style.setProperty("--ui-zoom-projects", "1.65"));
  await page.getByTestId("inboxColumn-projects-trigger").click();
  await page.getByTestId("inboxColumn-projects-options").getByRole("option", { name: project }).click();
  await page.keyboard.press("Escape");
  await page.getByTestId("workspace-group-count-needs-you").getByText("1 of 2").waitFor();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const box = await page.getByTestId("workspace-group-needs-you").evaluate((section) => {
    const row = section.querySelector(".ws-row")!.getBoundingClientRect();
    const header = section.querySelector(".ws-lab")!.getBoundingClientRect();
    const textBounds = [...section.querySelectorAll(".ws-lab span, .ws-lab i, .ws-lab .ws-show-all")].flatMap((element) => {
      const text = document.createRange();
      text.selectNodeContents(element);
      return [...text.getClientRects()].filter((rect) => rect.width && rect.height).map(({ left, right, bottom }) => ({ left, right, bottom }));
    });
    return { firstRow: row.top, left: header.left, right: header.right, textBounds };
  });
  assert.ok(box.textBounds.length >= 4, "title, filtered count, snoozed count and Show all at once");
  assert.ok(box.textBounds.every(({ left, right, bottom }) => left >= box.left && right <= box.right && bottom <= box.firstRow), JSON.stringify(box));
});
