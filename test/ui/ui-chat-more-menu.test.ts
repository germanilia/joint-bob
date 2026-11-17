// The desktop conversation header's ⋯ menu is grouped and lists each action once, and the details column beside it is tabs
// and content only: no row of buttons under the tabs, no footer. Notify and Auto respond are the column's two switches
// (the first section of Activity), so the menu does not repeat them.
//
// Run with `npm run test:file -- test/ui/ui-chat-more-menu.test.ts`.
import assert from "node:assert/strict";
import test from "node:test";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("the ⋯ menu groups its actions and the details column holds tabs, content and the two switches", { timeout: 300_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  page.context().setDefaultTimeout(60_000);
  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(node.url);
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Thread-Based Agent Builder" }) }).first().click();
  await page.locator("#sessionTitle").filter({ hasText: "Thread-Based Agent Builder" }).waitFor();
  await page.getByTestId("chat-more-button").click();

  // What a person sees, top to bottom: headings, rules and visible buttons.
  const lines = await page.evaluate(`(() => [...document.querySelectorAll("#chatMoreMenu .chat-more-actions > *")]
    .filter((item) => item.getBoundingClientRect().height > 0)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .map((item) => item.classList.contains("chat-more-rule") ? "---" : item.classList.contains("chat-more-group") ? "# " + item.textContent.trim() : item.getAttribute("aria-label")))()`) as string[];
  const index = (label: string) => lines.indexOf(label);
  assert.equal(lines[0], "# Open", JSON.stringify(lines));
  assert.ok(index("Terminal") === 1 && index("Browser") === 2, JSON.stringify(lines));
  assert.ok(index("# This conversation") > index("Browser"), JSON.stringify(lines));
  for (const label of ["Rename", "Share conversation", "Add secret", "Automations", "Dashboard"]) assert.ok(index(label) > index("# This conversation"), `${label}: ${JSON.stringify(lines)}`);
  assert.equal(lines.at(-1), "Delete conversation", "Delete stands alone at the end");
  assert.equal(lines.at(-2), "---", "a rule sets Delete apart");
  for (const label of ["Notify", "Auto respond"]) assert.equal(index(label), -1, `${label} is a switch in the details column, not a menu item`);

  // The details column: tabs, then content. Browser, Terminal, Share and Schedule are only in the menu.
  await page.getByTestId("chat-more-button").click();
  await page.getByTestId("activity-panel").waitFor();
  assert.equal(await page.locator("#detailsLinks, #detailsFoot").count(), 0, "the button row and the footer are gone");
  const column = await page.evaluate(`(() => {
    const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
    const sections = [...document.querySelectorAll("#activityOverview > details")].map((item) => item.id);
    return { tabs: rect("#activityPanel .activity-tabs").bottom, body: rect("#activityBody").top, sections,
      switches: [...document.querySelectorAll("#activityWhenStops [role=switch]")].map((item) => item.textContent.trim()) };
  })()`) as { tabs: number; body: number; sections: string[]; switches: string[] };
  assert.ok(column.body - column.tabs <= 16, `the content sits right under the tabs: ${JSON.stringify(column)}`);
  assert.equal(column.sections[0], "activityWhenStops", "the switches are Activity's first section");
  assert.deepEqual(column.switches, ["Answer for me", "Notify me"]);
  // A switch still works the conversation's own control: Answer for me opens the same dialog the old menu item did.
  await page.getByTestId("details-auto-respond-switch").click();
  await page.locator("#autoRespondDialog[open]").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("#autoRespondDialog[open]").waitFor({ state: "detached" });
  // Schedule is reached from the menu.
  await page.getByTestId("chat-more-button").click();
  await page.getByTestId("chat-automations-button").click();
  await page.getByTestId("automation-editor").waitFor();
  // Attaching a secret is an option of the conversation: the menu's Add secret opens the picker.
  await page.getByTestId("automation-back").click();
  await page.getByTestId("automation-editor").waitFor({ state: "detached" });
  await page.getByTestId("chat-more-button").click();
  await page.getByTestId("chat-attach-secret-button").click();
  await page.getByTestId("conversation-secret-dialog").waitFor();
  await page.getByTestId("conversation-secret-cancel").click();
  await page.getByTestId("conversation-secret-dialog").waitFor({ state: "detached" });
});
