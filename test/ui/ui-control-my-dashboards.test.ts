import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { waitInPage } from "./wait-in-page.js";

/** A stand-in dashboard agent: the request's "Title: ..." line names the dashboard, "refresh with AI" makes it an AI one. */
const AGENT = `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export default async (input) => {
  if (input.prompt.startsWith("You are refreshing")) return JSON.stringify({ generatedAt: new Date().toISOString(), bugs: 99 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const request = input.prompt.split("## The person's request")[1] ?? "";
  const draft = /Draft folder \\(edit here\\): (.+)/.exec(input.prompt)[1].trim();
  await mkdir(draft, { recursive: true });
  const title = /Title: ([^\\n]+)/.exec(request)?.[1] ?? "Bugs";
  const ai = request.includes("refresh with AI");
  await writeFile(path.join(draft, "manifest.json"), JSON.stringify({ title, refresh: ai ? { method: "ai", prompt: "Count bugs" } : { method: "script", command: 'node "$JOINT_BOB_DASHBOARD_DIR/refresh.mjs"' } }));
  await writeFile(path.join(draft, "refresh.mjs"), "console.log(JSON.stringify({ generatedAt: new Date().toISOString(), bugs: 7 }))");
  await writeFile(path.join(draft, "index.html"), "<script>const data = JointBobKit.payload(); JointBobKit.mount(JointBobKit.kpi({ label: 'Bugs', value: data.bugs ?? 0 }))</script>");
  return "I built the dashboard.";
};
`;

async function signedIn(t: test.TestContext) {
  const fixture = await nativeUiFixture(t, (root) => {
    const module = path.join(root, "dashboard-agent.mjs");
    writeFileSync(module, AGENT);
    return { JOINT_BOB_DASHBOARD_AGENT: module };
  });
  const { page, environment, node } = fixture;
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  await waitInPage(page, async () => (await import("/app/state.js")).state.preferencesLoaded);
  // Boot resets the view to the project list as its last step; open the control center only after that.
  await page.waitForTimeout(500);
  // With a project open the page listens for what the server announces, such as Bob's messages.
  await page.locator("#projectList .list-row").first().click();
  await waitInPage(page, async () => (await import("/app/state.js")).state.watchSocket?.readyState === 1);
  return fixture;
}


test("the Dashboard view sits beside the board: ask for dashboards in words, switch between them, and choose the default", { timeout: 240_000 }, async (t) => {
  const { page } = await signedIn(t);
  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-live").waitFor();

  // The view is the tab next to the board; with nothing yet it says how to ask for one.
  await page.getByTestId("control-tab-my-dashboard").click();
  await page.getByTestId("control-mydash-empty").waitFor();
  assert.equal(await page.locator("#controlViewLive").isHidden(), true, "the board gives way to the dashboard");

  const ask = async (text: string) => {
    await page.getByTestId("control-mydash-new").click();
    await page.getByTestId("control-mydash-text").fill(text);
    await page.getByTestId("control-mydash-send").click();
  };
  const chip = (title: string) => page.locator('[data-testid="control-mydash-chip"]', { hasText: title });

  // Asked for in words, Bob builds it; when it is ready it is shown in place, with data, as the default.
  await ask("what needs my attention everywhere\nTitle: Attention");
  await chip("★ Attention").waitFor({ timeout: 60_000 });
  await page.getByTestId("control-mydash-frame").waitFor({ timeout: 60_000 });
  await page.frameLocator('[data-testid="control-mydash-frame"]').getByText("7").first().waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="control-mydash-status"]', { hasText: "Refreshed" }).waitFor({ timeout: 30_000 });
  assert.equal(await page.getByTestId("control-mydash-default").isDisabled(), true);

  // A second one is kept beside it; the person makes it the default, and the view opens with it.
  await ask("spend per project\nTitle: Spend");
  await chip("Spend").waitFor({ timeout: 60_000 });
  await page.locator('[data-testid="control-mydash-chip"][data-status="ready"]', { hasText: "Spend" }).waitFor({ timeout: 60_000 });
  await chip("Spend").click();
  await page.getByTestId("control-mydash-frame").waitFor();
  await page.getByTestId("control-mydash-default").click();
  await chip("★ Spend").waitFor();
  assert.equal(await chip("★ Attention").count(), 0);

  // Back to the conversations and to the dashboard again: it opens with the default.
  await page.getByTestId("control-tab-live").click();
  assert.equal(await page.locator("#controlViewLive").isVisible(), true);
  await page.getByTestId("control-tab-my-dashboard").click();
  await page.locator('[data-testid="control-mydash-chip"].active', { hasText: "★ Spend" }).waitFor();
  await page.getByTestId("control-mydash-frame").waitFor();
  if (process.env.JOINT_BOB_UI_SHOT) await page.screenshot({ path: process.env.JOINT_BOB_UI_SHOT });

  // Deleting it leaves the other as the default.
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await page.getByTestId("control-mydash-delete").click();
  await chip("★ Attention").waitFor();
  assert.equal(await page.getByTestId("control-mydash-chip").count(), 1);
});
