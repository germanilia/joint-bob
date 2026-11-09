import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function signIn(page: Page, url: string, environment: { username: string; password: string }): Promise<void> {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  // Boot resets the view to the project list as its last step; open the control center only after that.
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
}

test("the webhook log lists every call a page at a time with how it ended; a call opens its conversation, its webhook, a question to Bob, or is cleared", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment);
  const projects = await page.evaluate(async () => (await (await fetch("/api/projects")).json()).projects as Array<{ id: string; name: string }>);
  const project = projects[0];
  // A real conversation of the project, so Open conversation has something to open.
  const conversation = await page.evaluate(async (id) => {
    const { sessions } = await (await fetch(`/api/projects/${encodeURIComponent(id)}/sessions`)).json() as { sessions: Array<{ id: string; conversationId?: string; title: string }> };
    return { id: sessions[0].conversationId ?? sessions[0].id, title: sessions[0].title };
  }, project.id);

  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const project = ${JSON.stringify(project)};
    const conversation = ${JSON.stringify(conversation)};
    const make = (index, label, extra = {}) => ({
      id: 't' + index, webhookId: 'w1', webhookName: 'GitHub', projectId: project.id, projectName: project.name, title: 'Issue #' + (480 + index) + ' opened: Problem number ' + index,
      summary: 'acme/joint-bob · by matan', receivedAt: new Date(Date.now() - index * 600000).toISOString(),
      outcome: { label, reason: label ? 'Existing fix found. (decision model 95%)' : '' }, conversation: label ? conversation : null, ...extra });
    window.__triggers = [make(1, 'settled'), make(2, 'needs you'), make(3, ''), make(4, 'in hand'), make(5, 'settled'), make(6, 'settled'), make(7, 'settled'), make(8, 'settled'), make(9, 'settled')];
    window.__make = make;
    window.__requests = [];
    window.__timeline = [];
    const live = () => window.__triggers.filter((trigger) => !trigger.cleared);
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      const method = (args[1]?.method || 'GET').toUpperCase();
      const body = args[1]?.body ? JSON.parse(args[1].body) : undefined;
      if (url.pathname === '/api/control-center/triggers' && method === 'GET') {
        const page = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('size') || 10);
        window.__requests.push({ list: { page, size } });
        return json({ triggers: live().slice((page - 1) * size, page * size), total: live().length });
      }
      if (url.pathname === '/api/control-center/triggers/dismiss' && method === 'POST') {
        window.__requests.push({ dismiss: body });
        let dismissed = 0;
        for (const trigger of window.__triggers) if (!trigger.cleared && (body.all || body.ids.includes(trigger.id))) { trigger.cleared = true; dismissed += 1; }
        return json({ dismissed });
      }
      const triage = /^\\/api\\/control-center\\/triggers\\/([^/]+)\\/triage$/.exec(url.pathname);
      if (triage) {
        const trigger = window.__triggers.find((candidate) => candidate.id === triage[1]);
        window.__requests.push({ triage: trigger.id });
        return json({ message: 'Triage this incoming webhook call for me: ' + trigger.title, projectId: trigger.projectId });
      }
      if (url.pathname === '/api/control-center/bob/message') {
        window.__requests.push({ message: body });
        const user = { id: 'm1', role: 'user', text: body.message, via: null, projectId: body.projectId ?? null, projectName: null, importance: 'fyi', actions: [], createdAt: new Date().toISOString() };
        const reply = { id: 'm2', role: 'bob', text: 'It is a routine report; nothing is broken.', via: 'Decision model 95% · question', projectId: body.projectId ?? null, projectName: null, importance: 'fyi', actions: [], createdAt: new Date().toISOString() };
        window.__timeline.push(user, reply);
        return json({ action: 'answer', user, reply, projectId: body.projectId ?? null });
      }
      if (url.pathname === '/api/control-center/bob/messages') return json({ messages: window.__timeline, waiting: 0 });
      if (url.pathname === '/api/control-center/board') return json({ cards: [], projects: ${JSON.stringify(projects)}.map((item) => ({ id: item.id, name: item.name })) });
      return originalFetch(...args);
    };
  })()`);

  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-chat").waitFor();

  // The log's button sits next to the monitoring switch in Bob's header, with nothing counting on it.
  const button = page.getByTestId("control-triggers-bell");
  await button.waitFor();
  assert.equal(await button.evaluate((node) => node.nextElementSibling?.id), "controlChatMonitor");
  assert.equal(await button.getAttribute("aria-label"), "Webhook log");
  assert.equal(await button.locator(".control-bell-badge").count(), 0, "no badge: nothing in the log asks for attention");
  assert.equal(await page.getByTestId("control-triggers-panel").isHidden(), true);

  // Opening it lists the first page, sized to the panel so nothing scrolls; the rest is on the next pages.
  await button.click();
  await page.getByTestId("control-triggers-panel").waitFor({ state: "visible" });
  await page.getByTestId("control-trigger").first().waitFor();
  assert.match(await page.getByTestId("control-triggers-panel").innerText(), /^Webhook log/);
  const rows = page.getByTestId("control-trigger");
  const firstPage = await rows.count();
  assert.ok(firstPage >= 2 && firstPage < 9, `a page holds what fits, got ${firstPage}`);
  assert.equal(await page.getByTestId("control-triggers-list").evaluate((list) => list.scrollHeight <= list.clientHeight + 1), true, "the list fits its box");
  // Each call says how its conversation ended, and opens it.
  assert.match(await rows.first().innerText(), new RegExp(`Issue #481 opened: Problem number 1 · .*\\n.*acme/joint-bob · by matan\\n.*webhook GitHub · 10 min ago · settled: “${conversation.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}”`));
  assert.deepEqual(await rows.first().getByRole("button").allTextContents(), ["Open conversation", "Webhook", "Ask Bob", "Clear"]);
  assert.equal(await rows.nth(1).getAttribute("data-outcome"), "needs you");
  assert.match(await rows.first().getByTestId("control-trigger-meta").getAttribute("title") ?? "", /Existing fix found\. \(decision model 95%\)/, "why is on hover");
  assert.match(await page.getByTestId("control-triggers-page-label").innerText(), new RegExp(`^1–${firstPage} of 9$`));
  // A call whose conversation is not known yet says so, and has nothing to open.
  const pageLabel = page.getByTestId("control-triggers-page-label");
  const turnPage = async (direction: "previous" | "next") => {
    const was = await pageLabel.innerText();
    await page.getByTestId(`control-triggers-page-${direction}`).click();
    await page.waitForFunction((label) => document.querySelector('[data-testid="control-triggers-page-label"]')?.textContent !== label, was);
  };
  while (await page.locator('[data-testid="control-trigger"][data-outcome="unknown"]').count() === 0) await turnPage("next");
  const unknown = page.locator('[data-testid="control-trigger"][data-outcome="unknown"]');
  assert.match(await unknown.getByTestId("control-trigger-meta").innerText(), /no conversation known yet$/);
  assert.deepEqual(await unknown.getByRole("button").allTextContents(), ["Webhook", "Ask Bob", "Clear"]);
  while (!(await pageLabel.innerText()).startsWith("1–")) await turnPage("previous");
  await page.waitForFunction(() => document.querySelector('[data-testid="control-trigger"]')?.getAttribute("data-id") === "t1");

  // Ask Bob: the question goes through Bob's chat like anything typed there, with the call's project, and a half-typed message stays.
  await button.click();
  await page.getByTestId("control-chat-input").fill("half typed message");
  await button.click();
  await page.getByTestId("control-trigger").first().waitFor();
  await page.getByTestId("control-trigger-triage").first().click();
  await page.getByTestId("control-chat-messages").getByText("It is a routine report; nothing is broken.").waitFor();
  const sent = (await page.evaluate("window.__requests") as Array<{ message?: { message: string; projectId?: string } }>).find((entry) => entry.message)!.message!;
  assert.equal(sent.message, "Triage this incoming webhook call for me: Issue #481 opened: Problem number 1");
  assert.equal(sent.projectId, project.id);
  assert.equal(await page.getByTestId("control-chat-input").inputValue(), "half typed message", "what the person was typing is kept");
  assert.equal(await page.getByTestId("control-triggers-panel").isHidden(), true, "the panel gets out of the way of the answer");
  await page.getByTestId("control-chat-input").fill("");

  // Clear one, then the whole log.
  await button.click();
  await page.getByTestId("control-trigger").first().waitFor();
  await page.getByTestId("control-trigger-dismiss").first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="control-trigger"]')?.getAttribute("data-id") === "t2");
  assert.match(await page.getByTestId("control-triggers-page-label").innerText(), /of 8$/);
  await page.getByTestId("control-triggers-dismiss-all").click();
  await page.getByText("No webhook calls yet.").waitFor();
  assert.equal(await page.getByTestId("control-triggers-dismiss-all").isDisabled(), true);
  assert.deepEqual((await page.evaluate("window.__requests") as Array<{ dismiss?: unknown }>).filter((entry) => entry.dismiss).at(-1), { dismiss: { all: true } });

  // A call that arrives while the log is open appears in it at once.
  await page.evaluate(`(() => { window.__triggers.push(window.__make(0, 'in hand', { title: 'Stripe invoice.payment_failed (test mode)' })); window.dispatchEvent(new CustomEvent('control-center-changed')); })()`);
  await page.getByTestId("control-trigger-title").getByText("Stripe invoice.payment_failed (test mode)").waitFor();

  // Webhook opens the webhook's own screen in the project; Esc closes the log without leaving the control center.
  await page.keyboard.press("Escape");
  await page.getByTestId("control-triggers-panel").waitFor({ state: "hidden" });
  assert.equal(await page.locator("body.view-control").count(), 1, "Esc closed the log, not the control center");
  await button.click();
  await page.getByTestId("control-trigger-open").first().click();
  await page.getByTestId("project-webhooks-dialog").waitFor();
  assert.match(await page.locator("#projectWebhooksHeading").innerText(), new RegExp(`^${project.name} webhooks$`));
  await page.getByTestId("project-webhooks-close").click();
  await page.getByTestId("project-webhooks-dialog").waitFor({ state: "detached" });
  assert.equal(await page.getByTestId("control-triggers-panel").isHidden(), true, "Webhook closes the log");

  // Open conversation opens the conversation that worked on the call, over the board.
  await button.click();
  await page.getByTestId("control-trigger-conversation").first().click();
  await page.waitForFunction(() => document.body.classList.contains("control-popup"));
  assert.equal(await page.getByTestId("control-triggers-panel").isHidden(), true);
  assert.deepEqual(await page.evaluate("window.__timeline"), [{ id: "m1", role: "user", text: "Triage this incoming webhook call for me: Issue #481 opened: Problem number 1", via: null, projectId: project.id, projectName: null, importance: "fyi", actions: [], createdAt: (await page.evaluate("window.__timeline[0].createdAt")) }, (await page.evaluate("window.__timeline[1]"))], "only what the person asked is in Bob's chat");
});
