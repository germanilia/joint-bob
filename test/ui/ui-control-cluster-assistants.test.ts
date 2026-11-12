import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { waitInPage } from "./wait-in-page.js";

/** Waits until the page has sent this many of the requests the test catches. */
async function sent(page: { evaluate: (expression: string) => Promise<unknown> }, count: number): Promise<void> {
  for (const deadline = Date.now() + 30_000; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
    if (await page.evaluate("window.__sent.length") === count) return;
    if (Date.now() > deadline) throw new Error(`The page never sent request ${count}`);
  }
}

async function signedIn(t: test.TestContext) {
  const fixture = await nativeUiFixture(t);
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


test("the Assistants tab lists cluster assistants; those who manage one edit it, read its audit log and delete it", { timeout: 180_000 }, async (t) => {
  const { page } = await signedIn(t);
  // The list and what the buttons send are fixtures; the section, its dialogs and its requests are the real page's.
  await page.evaluate(`(() => {
    const hosted = { id: "11111111-1111-4111-8111-111111111111", name: "Poster", about: "Drafts posts", has: ["Browser login · example.test"], clusterId: "c1", clusterName: "Team", nodeId: "n1", machineName: "Homeserver", local: true, canManage: true, instructions: "Draft only." };
    const remote = { ...hosted, id: "22222222-2222-4222-8222-222222222222", name: "Scheduler", machineName: "Laptop", local: false, canManage: false, instructions: null };
    window.__list = [hosted, remote];
    window.__sent = [];
    window.__skills = [{ id: "33333333-3333-4333-8333-333333333333", name: "poster" }];
    const originalFetch = window.fetch;
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href).pathname, method = (args[1] && args[1].method) || "GET";
      if (url === "/api/control-center/cluster-assistants") return reply({ assistants: window.__list });
      if (url.endsWith("/audit")) return reply({ events: [
        { id: "e2", eventType: "cluster-assistant.asked", actorId: "a2", details: { askerName: "maya", purpose: "this week's post" }, createdAt: "2026-11-12T10:00:00.000Z" },
        { id: "e1", eventType: "cluster-assistant.created", actorId: "a1", details: { name: "Poster" }, createdAt: "2026-11-12T09:00:00.000Z" },
      ] });
      if (method === "GET" && url.startsWith("/api/control-center/cluster-assistants/")) return reply({ name: "Poster", instructions: "Draft only.", skills: window.__skills });
      if (url.includes("/skills/")) { window.__sent.push({ method, url, body: null }); window.__skills = []; return reply({ done: true }); }
      if (url.startsWith("/api/control-center/cluster-assistants/")) {
        window.__sent.push({ method, url, body: args[1].body ? JSON.parse(String(args[1].body)) : null });
        if (method === "DELETE") window.__list = window.__list.slice(1);
        return reply({ saved: true });
      }
      return originalFetch(...args);
    };
  })()`);
  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-assistants").click();

  const rows = page.getByTestId("control-cluster-assistant");
  await rows.first().waitFor();
  assert.equal(await rows.count(), 2);
  assert.match((await rows.nth(0).textContent())!, /Poster.*Cluster Team · on Homeserver \(this machine\).*Drafts posts/);
  assert.equal(await rows.nth(0).getByTestId("control-cluster-assistant-edit").count(), 1);
  assert.equal(await rows.nth(1).locator("button").count(), 0, "one on another machine is only listed");

  // Its audit log says who did what.
  await rows.nth(0).getByTestId("control-cluster-assistant-log").click();
  const events = page.getByTestId("control-cluster-assistant-event");
  await events.first().waitFor();
  assert.match((await events.nth(0).textContent())!, /maya asked it: this week's post$/);
  assert.match((await events.nth(1).textContent())!, /Created as "Poster"$/);
  if (process.env.JOINT_BOB_UI_SHOT) await page.screenshot({ path: process.env.JOINT_BOB_UI_SHOT });
  await page.getByTestId("control-cluster-assistant-audit-close").click();

  // Editing sends the name and the instructions.
  await rows.nth(0).getByTestId("control-cluster-assistant-edit").click();
  assert.equal(await page.getByTestId("control-cluster-assistant-instructions").inputValue(), "Draft only.");
  // Its own skills are listed there, and one can be removed.
  await page.getByTestId("control-cluster-assistant-skill-remove").click();
  await page.locator("#confirmDialog[open] button", { hasText: "Remove" }).click();
  await sent(page, 1);
  await page.locator('[data-testid="control-cluster-assistant-skills"]', { hasText: "None." }).waitFor();
  await page.getByTestId("control-cluster-assistant-name").fill("Team poster");
  await page.getByTestId("control-cluster-assistant-instructions").fill("Draft only; never publish.");
  await page.getByTestId("control-cluster-assistant-save").click();
  await sent(page, 2);

  // Deleting asks first, in the app's own dialog.
  await rows.nth(0).getByTestId("control-cluster-assistant-delete").click();
  await page.locator("#confirmDialog[open] button", { hasText: "Delete" }).click();
  await sent(page, 3);
  assert.deepEqual(await page.evaluate("window.__sent"), [
    { method: "DELETE", url: "/api/control-center/cluster-assistants/11111111-1111-4111-8111-111111111111/skills/33333333-3333-4333-8333-333333333333", body: null },
    { method: "PUT", url: "/api/control-center/cluster-assistants/11111111-1111-4111-8111-111111111111", body: { name: "Team poster", instructions: "Draft only; never publish." } },
    { method: "DELETE", url: "/api/control-center/cluster-assistants/11111111-1111-4111-8111-111111111111", body: null },
  ]);
  await waitInPage(page, async () => document.querySelectorAll('[data-testid="control-cluster-assistant"]').length === 1);
});
