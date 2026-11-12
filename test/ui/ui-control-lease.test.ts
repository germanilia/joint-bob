import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("opening a conversation over the board takes control, Esc or Close gives it back, and Keep Bob out keeps it after closing", async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);

  // A real conversation from the seeded projects, shown as a running card.
  const real = await page.evaluate(`(async () => {
    const { projects } = await (await fetch('/api/projects')).json();
    for (const project of projects) {
      const { sessions } = await (await fetch('/api/projects/' + project.id + '/sessions')).json();
      if (sessions.length) { const session = sessions[0]; return { projectId: project.id, projectName: project.name, conversationId: session.conversationId ?? session.id, sessionId: session.id, path: session.path, title: session.title }; }
    }
    throw new Error('no seeded conversation');
  })()`) as { projectId: string; projectName: string; conversationId: string; sessionId: string; path: string; title: string };
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    const real = ${JSON.stringify(real)};
    window.__lease = [];
    window.__held = null;
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/api/control-center/board') {
        return reply({ projects: [{ id: real.projectId, name: real.projectName }], cards: [{ ...real, column: window.__column || 'running', agentId: 'claude', agentLabel: 'Claude', agentModel: null, executionNodeId: null, updatedAt: null, turnRunning: true, backgroundRunning: false, summary: null, autoRespondActive: true, startedBy: 'bob', pendingReviews: [], autoRespondStop: null, controlledBy: window.__held }] });
      }
      if (path === '/api/control-center/summary') return reply({ waiting: 0 });
      if (path === '/api/control-center/lease') {
        const body = JSON.parse(args[1].body);
        window.__lease.push(body.action);
        if (body.action === 'keep-out' || body.action === 'let-in') window.__keptOut = body.action === 'keep-out';
        if (body.action === 'release') window.__keptOut = false;
        window.__held = body.action === 'release' ? null : 'you';
        return reply({ leased: body.action !== 'release', keptOut: Boolean(window.__keptOut) });
      }
      return originalFetch(...args);
    };
  })()`);

  await page.getByTestId("projects-open-control-center-button").click();
  // Bob's page opens on his chat; the board is his Live agents tab.
  await page.getByTestId("control-tab-live").click();
  const card = page.getByTestId("control-center-card");
  await card.waitFor();
  assert.equal(await card.getByTestId("control-card-action-give-back").count(), 0);
  const composer = page.locator("#composer");
  const mode = page.getByTestId("control-popup-mode");

  const lease = () => page.evaluate("window.__lease") as Promise<string[]>;
  const keepOut = page.getByTestId("control-popup-keep-out-toggle");

  // Opening a card puts the person in control at once: the message box and "Give back to Bob", without pressing Take control.
  // On Bob's page the popup bar is the one control line: it carries Give back, and the lease banner stays hidden.
  const giveBack = page.getByTestId("control-popup-bar").getByTestId("control-lease-give-back");
  await card.locator(".control-title").click();
  await page.getByTestId("control-popup-bar").waitFor({ state: "visible" });
  assert.equal(await page.locator("body.view-control.control-popup").count(), 1, "the board stays under the conversation");
  await giveBack.waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("control-lease-banner").isVisible(), false);
  // It opens over the stage, beside Bob's chat, which stays visible.
  const sides = await page.evaluate(() => ({ chat: document.querySelector("#controlChat")!.getBoundingClientRect(), popup: document.querySelector("#chatPanel")!.getBoundingClientRect() }));
  assert.ok(sides.popup.left >= sides.chat.right - 1 || sides.popup.right <= sides.chat.left + 1, `the conversation sits beside Bob's chat: ${JSON.stringify(sides)}`);
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), true);
  await composer.waitFor({ state: "visible" });
  assert.match(await mode.innerText(), /You're in it/);
  assert.equal(await page.getByTestId("control-popup-take").isVisible(), false);
  assert.equal(await keepOut.isChecked(), false);
  assert.deepEqual(await lease(), ["take"]);
  // The whole message box fits in the window: the popup is never taller than the space under its top edge.
  const fit = await page.evaluate(() => ({ composer: document.querySelector("#composer")!.getBoundingClientRect().bottom, panel: document.querySelector("#chatPanel")!.getBoundingClientRect().bottom, window: innerHeight }));
  assert.ok(fit.composer <= fit.panel && fit.panel <= fit.window, `composer ${fit.composer}, panel ${fit.panel}, window ${fit.window}`);

  // Giving it back in the open view goes back to watching; Take control there takes it again.
  await giveBack.click();
  await giveBack.waitFor({ state: "hidden" });
  await composer.waitFor({ state: "hidden" });
  assert.match(await mode.innerText(), /Watching · Bob keeps driving/);
  await page.getByTestId("control-popup-take").click();
  await composer.waitFor({ state: "visible" });
  assert.deepEqual(await lease(), ["take", "release", "take"]);

  // Esc in the message box closes the conversation, not the control center, and hands it back to Bob.
  await page.locator("#messageInput").focus();
  await page.keyboard.press("Escape");
  await page.getByTestId("control-popup-bar").waitFor({ state: "hidden" });
  assert.equal(await page.locator("body.view-control").count(), 1);
  await page.waitForFunction(() => (window as unknown as { __lease: string[] }).__lease.length === 4);
  assert.deepEqual(await lease(), ["take", "release", "take", "release"]);

  // Keep Bob out: closing no longer gives it back, and reopening shows it still kept out.
  await page.getByTestId("control-center-card").locator(".control-title").click();
  await composer.waitFor({ state: "visible" });
  await keepOut.check();
  await page.waitForFunction(() => /even after you close/.test(document.querySelector("#controlPopupMode")!.textContent!));
  await page.getByTestId("control-popup-close").click();
  await page.getByTestId("control-popup-bar").waitFor({ state: "hidden" });
  await page.waitForTimeout(300);
  assert.deepEqual(await lease(), ["take", "release", "take", "release", "take", "keep-out"]);
  await page.evaluate("window.dispatchEvent(new CustomEvent('control-center-changed'))");
  await page.getByTestId("control-center-card").getByTestId("control-card-action-give-back").waitFor();
  await page.getByTestId("control-center-card").locator(".control-title").click();
  await composer.waitFor({ state: "visible" });
  await page.waitForFunction(() => (document.querySelector('[data-testid="control-popup-keep-out-toggle"]') as HTMLInputElement).checked);
  // Turning it off lets Bob back in once the conversation closes.
  await keepOut.uncheck();
  await page.waitForFunction(() => (window as unknown as { __lease: string[] }).__lease.at(-1) === "let-in");
  await page.getByTestId("control-popup-close").click();
  await page.waitForFunction(() => (window as unknown as { __lease: string[] }).__lease.at(-1) === "release");
  assert.deepEqual(await lease(), ["take", "release", "take", "release", "take", "keep-out", "take", "let-in", "release"]);

  // A conversation held elsewhere says so on its card, which offers the way back.
  await page.evaluate("window.__held = 'you'; window.dispatchEvent(new CustomEvent('control-center-changed'))");
  const held = page.getByTestId("control-center-card");
  await held.getByTestId("control-card-action-give-back").waitFor();
  assert.match(await held.innerText(), /You're in it/);
  await held.getByTestId("control-card-action-give-back").click();
  await page.getByTestId("control-card-action-take-control").waitFor();
  assert.deepEqual((await lease()).slice(-1), ["release"]);

  // A card that waits for the person opens with them in control, ready to answer, without pressing Take control.
  await page.evaluate("window.__column = 'needs-you'; window.dispatchEvent(new CustomEvent('control-center-changed'))");
  await page.locator('[data-testid="control-center-card"][data-column="needs-you"]').waitFor();
  await page.getByTestId("control-center-card").locator(".control-title").click();
  await giveBack.waitFor({ state: "visible" });
  await composer.waitFor({ state: "visible" });
  assert.match(await mode.innerText(), /You're in it/);
  assert.deepEqual((await lease()).slice(-1), ["take"]);
});
