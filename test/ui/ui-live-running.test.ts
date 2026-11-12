import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("live start renders the conversation immediately and refreshes the running badge within one second", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator('#loginDialog[open]').waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3);
  await page.locator("#projectList .list-row", { hasText: "Internal Assistant" }).locator("button").first().click();
  await page.locator('[data-filter="all"]').click();
  await page.locator("#sessionList .list-row", { hasText: "Short one" }).waitFor();
  const result = await page.evaluate(`(async () => {
    const { state } = await import('/app/state.js');
    const { closeWatchSocket, closeSocket, handleSocketPayload } = await import('/app/socket.js');
    closeWatchSocket(); closeSocket();
    while (state.sessionsRefreshing) await new Promise(resolve => setTimeout(resolve, 20));
    const session = state.sessions.find(session => session.title === 'Short one');
    state.activeSessionId = session.id;
    state.activeSessionPath = session.path;
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const pathname = new URL(String(args[0]), location.href).pathname;
      if (pathname === '/api/running') return new Response(JSON.stringify({ projects: [{
        projectId: state.activeProjectId, projectName: 'Internal Assistant',
        sessions: [{ ...session, running: true, turnRunning: true }],
      }] }), { headers: { 'content-type': 'application/json' } });
      // The immediate row update must not depend on a list HTTP response.
      if (pathname.endsWith('/sessions')) return new Promise(() => {});
      return originalFetch(...args);
    };
    const label = () => [...document.querySelectorAll('#sessionList .list-row')]
      .find(row => row.textContent.toLowerCase().includes('short one')).querySelector('.chat-badge b').textContent;
    const before = label();
    handleSocketPayload({ type: 'agent_start' });
    handleSocketPayload({ type: 'sessionsChanged' });
    return { before, after: label() };
  })()`);
  assert.notEqual(result.before, "Running", "fixture must start idle");
  assert.equal(result.after, "Running", "agent_start must render Running without waiting for the sessions API");
  await page.waitForFunction(() => {
    const badge = document.querySelector('[data-testid="running-conversations-open-button"] [data-running-count]') as HTMLElement;
    return !badge.hidden && badge.textContent === "1";
  }, null, { timeout: 1000 });
});

test("a notice about the open project rescans every project only when its running set changed", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator('#loginDialog[open]').waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3);
  await page.locator("#projectList .list-row", { hasText: "Internal Assistant" }).locator("button").first().click();
  await page.locator('[data-filter="all"]').click();
  await page.locator("#sessionList .list-row", { hasText: "Short one" }).waitFor();
  const result = await page.evaluate(`(async () => {
    const { state } = await import('/app/state.js');
    const { closeWatchSocket, closeSocket, handleSocketPayload } = await import('/app/socket.js');
    closeWatchSocket(); closeSocket();
    const settled = async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      while (state.sessionsRefreshing) await new Promise(resolve => setTimeout(resolve, 20));
      await new Promise(resolve => setTimeout(resolve, 400));
    };
    await settled();
    // Scans scheduled while the page loaded are not this test's subject.
    clearTimeout(state.pendingReviewsRefreshTimer);
    state.pendingReviewsRefreshTimer = null;
    let sessions = state.sessions.map(session => ({ ...session, running: false, turnRunning: false, backgroundRunning: false }));
    state.sessions = sessions;
    const scans = { running: 0 };
    const originalFetch = window.fetch;
    const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    window.fetch = async (...args) => {
      const pathname = new URL(String(args[0]), location.href).pathname;
      if (pathname === '/api/running') { scans.running += 1; return json({ projects: [] }); }
      if (pathname.endsWith('/sessions')) return json({ sessions });
      return originalFetch(...args);
    };
    const notice = { type: 'sessionsChanged', projectId: state.activeProjectId };
    for (let index = 0; index < 5; index += 1) handleSocketPayload(notice);
    await settled();
    const unchanged = { running: scans.running, reviews: Boolean(state.pendingReviewsRefreshTimer) };
    sessions = sessions.map((session, index) => index ? session : { ...session, running: true, turnRunning: true });
    handleSocketPayload(notice);
    await settled();
    const started = scans.running;
    handleSocketPayload({ type: 'sessionsChanged' });
    await settled();
    return { unchanged, started, unnamed: scans.running };
  })()`) as { unchanged: { running: number; reviews: boolean }; started: number; unnamed: number };
  assert.deepEqual(result.unchanged, { running: 0, reviews: false }, "notices that changed nothing must not list every project");
  assert.equal(result.started, 1, "a conversation that started running must refresh the running list");
  assert.equal(result.unnamed, 2, "a notice that names no project still refreshes the running list");
});

test("a running conversation shows its Running mark whether it is open or not, and the mark follows the run without a reload", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  for (const [width, height] of [[1440, 900], [1100, 800], [390, 844]] as const) {
    if (width === 1440) {
      await page.setViewportSize({ width, height });
      await page.goto(node.url);
      await page.locator('#loginDialog[open]').waitFor();
      await page.locator("#loginUsernameInput").fill(environment.username);
      await page.locator("#loginPasswordInput").fill(environment.password);
      await page.locator("#loginSubmitButton").click();
      await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3);
      await page.locator("#projectList .list-row", { hasText: "Internal Assistant" }).locator("button").first().click();
      await page.locator('[data-filter="all"]').click();
      await page.locator("#sessionList .list-row", { hasText: "Short one" }).waitFor();
    } else {
      await page.setViewportSize({ width, height });
    }
    // The mark is in the row, whole (not cut by the row's one-line ellipsis), with a visible dot, and the row says "Running".
    const mark = (title: string) => page.evaluate((name) => {
      const row = [...document.querySelectorAll<HTMLElement>("#sessionList .list-row")].find((item) => item.textContent?.toLowerCase().includes(name.toLowerCase()));
      const badge = row?.querySelector<HTMLElement>(".chat-badge");
      const dot = badge?.querySelector<HTMLElement>(".chat-status-dot");
      const card = row?.querySelector<HTMLElement>(".session-card");
      if (!row || !badge || !dot || !card) return { present: false, running: false, whole: false, active: false };
      const own = badge.getBoundingClientRect(), frame = card.getBoundingClientRect(), dotBox = dot.getBoundingClientRect();
      let clip = frame.right;
      for (let node: HTMLElement | null = badge.parentElement; node && node !== card.parentElement; node = node.parentElement) {
        if (getComputedStyle(node).overflowX !== "visible") clip = Math.min(clip, node.getBoundingClientRect().right);
      }
      return {
        present: true, running: badge.classList.contains("chat-badge-active") && /Running/.test(badge.textContent ?? ""),
        whole: own.width > 0 && dotBox.width > 0 && getComputedStyle(badge).visibility === "visible" && Number(getComputedStyle(badge).opacity) > 0 && own.right <= clip + 0.5 && own.left >= frame.left,
        active: card.classList.contains("active"),
      };
    }, title);
    // The server's list says "running" for the conversation while window.__runMode is on (as /sessions does for a live turn).
    const run = (type: "agent_start" | "agent_end", title: string, open: boolean) => page.evaluate(async ([kind, name, select]) => {
      const w = window as unknown as { __runMode?: { on: boolean; title: string }; __runStubbed?: boolean };
      const { state } = await import("/app/state.js");
      const { closeWatchSocket, closeSocket, refreshSessionsQuietly } = await import("/app/socket.js");
      closeWatchSocket(); closeSocket();
      while (state.sessionsRefreshing) await new Promise((resolve) => setTimeout(resolve, 20));
      w.__runMode = { on: kind === "agent_start", title: name };
      const endpoint = `/api/projects/${encodeURIComponent(state.activeProjectId!)}/sessions`;
      if (!w.__runStubbed) {
        w.__runStubbed = true;
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (new URL(String(args[0]), location.href).pathname !== endpoint) return response;
          const body = await response.json();
          for (const item of body.sessions) {
            const mine = item.title === w.__runMode!.title;
            item.turnRunning = mine && w.__runMode!.on; item.running = item.turnRunning; item.reviewState = item.running ? "running" : "needs_review";
          }
          return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
        };
      }
      const session = state.sessions.find((item) => item.title === name)!;
      if (select) { state.activeSessionId = session.id; state.activeSessionPath = session.path; }
      else if (state.activeSessionId === session.id) { state.activeSessionId = null; state.activeSessionPath = null; }
      await refreshSessionsQuietly();
    }, [type, title, open] as const);
    for (const open of [false, true]) {
      await run("agent_start", "Short one", open);
      await page.waitForFunction(() => [...document.querySelectorAll("#sessionList .list-row")].some((row) => row.textContent?.toLowerCase().includes("short one") && row.querySelector(".chat-badge-active")), null, { timeout: 5_000 });
      const started = await mark("Short one");
      assert.equal(started.running, true, `${width}px, open ${open}: the row says Running`);
      assert.equal(started.whole, true, `${width}px, open ${open}: the Running mark is whole and in view (${JSON.stringify(started)})`);
      if (open) assert.equal(started.active, true, "the row is the open conversation's");
      await run("agent_end", "Short one", open);
      await page.waitForFunction(() => ![...document.querySelectorAll("#sessionList .list-row")].some((row) => row.textContent?.toLowerCase().includes("short one") && row.querySelector(".chat-badge-active")), null, { timeout: 5_000 });
      assert.equal((await mark("Short one")).running, false, `${width}px, open ${open}: the mark goes when the run ends`);
    }
  }
});
