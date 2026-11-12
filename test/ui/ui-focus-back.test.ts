import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { signIn } from "../dev-nodes.js";

test("phone titles read in title case at one size, and Back climbs a level instead of replaying visits and stays on Projects", { timeout: 180_000 }, async t => {
  const fixture = await nativeUiFixture(t);
  await signIn(fixture.environment, fixture.node);
  const context = await fixture.page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  t.after(() => context.close());
  // Chrome's Back skips an entry whose page pushed a new one without a gesture, which closed the installed app.
  await context.addInitScript(() => {
    const push = history.pushState.bind(history);
    Object.assign(window, { pushesWithoutGesture: 0 });
    history.pushState = (...args: Parameters<History["pushState"]>) => {
      if (!navigator.userActivation.isActive) Object.assign(window, { pushesWithoutGesture: (window as unknown as { pushesWithoutGesture: number }).pushesWithoutGesture + 1 });
      push(...args);
    };
  });
  const pushesWithoutGesture = (target: typeof page) => target.evaluate(() => (window as unknown as { pushesWithoutGesture: number }).pushesWithoutGesture);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(fixture.node.url);
  await page.getByTestId("login-username-input").fill(fixture.environment.username);
  await page.getByTestId("login-password-input").fill(fixture.environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("body.focus-ui .project-card").first().waitFor();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("body.view-sessions #sessionList .session-card").first().waitFor();

  const titles = await page.locator("#sessionList .session-card strong").evaluateAll(cards => cards.map(card => {
    const tail = card.querySelector(".session-title-tail");
    return { text: card.textContent!.trim(), size: getComputedStyle(card).fontSize, tailSize: tail ? getComputedStyle(tail).fontSize : null };
  }));
  assert.ok(titles.length > 0, "the project lists conversations to check");
  for (const title of titles) {
    assert.doesNotMatch(title.text, /(^|[\s\]])[a-z]/, `every word starts with a capital: ${title.text}`);
    if (title.tailSize) assert.equal(title.tailSize, title.size, `the last word is the same size as the title: ${title.text}`);
  }

  // Labelled titles split their last word into its own span; that word must stay the title's size.
  const sized = await page.evaluate(`(async () => {
    const { state } = await import("/app/state.js");
    const { renderSessions } = await import("/app/session-list.js");
    state.sessions[0].classification = "ux";
    renderSessions();
    const card = document.querySelector("#sessionList .session-card");
    const tail = card.querySelector(".session-title-tail");
    return { title: getComputedStyle(card.querySelector("strong")).fontSize, tail: tail ? getComputedStyle(tail).fontSize : null };
  })()`) as { title: string; tail: string | null };
  assert.ok(sized.tail, "a labelled title has a last-word span");
  assert.equal(sized.tail, sized.title, "the last word is the same size as the rest of the title");

  // The first Back after opening reaches the page's close watcher before any history step (Escape on a desktop).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await page.locator("body.view-projects").waitFor();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("body.view-sessions").waitFor();

  // Every Back climbs one level, with no tap in between, and on Projects it does nothing and stays in the app.
  const back = async (view: string) => {
    await page.goBack();
    await page.locator(`body.view-${view}`).waitFor();
  };
  await page.locator("#sessionList .session-card").first().click();
  await page.locator("body.view-chat").waitFor();
  await back("sessions");
  await back("projects");
  await back("projects");
  await back("projects");
  assert.equal(new URL(page.url()).origin, new URL(fixture.node.url).origin, "Back on Projects stays in the app");

  // The control center sits under Projects, whichever view it was opened from.
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("body.view-sessions").waitFor();
  await page.evaluate(async () => (await import("/app/layout.js")).setMobileView("control"));
  await page.locator("body.view-control").waitFor();
  await back("projects");

  // Opening the app restores the saved view without a gesture, so the Back steps wait for the first tap.
  const opened = await context.newPage();
  // Playwright's own page polling runs with a gesture, so wait for the start-up view without polling the page.
  await opened.goto(fixture.node.url);
  await new Promise(resolve => setTimeout(resolve, 5_000));
  assert.ok(await opened.evaluate(() => document.body.matches(".view-projects, .view-sessions, .view-control")), "the app restored a view");
  assert.equal(await pushesWithoutGesture(opened), 0, "opening the app pushes nothing without a gesture");
  assert.equal(await opened.evaluate(() => history.state?.backStep ?? 0), 0, "no Back steps before the first tap");
  await opened.mouse.click(1, 1);
  await opened.waitForFunction(() => history.state?.backStep === 20);
  assert.equal(await pushesWithoutGesture(page), 0, "Back never pushes without a gesture");
});
