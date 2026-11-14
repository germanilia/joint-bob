import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function openNewWorktreeDialog({ page, node, environment }: Awaited<ReturnType<typeof nativeUiFixture>>) {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Joint Bob" }).first().click();
  await page.locator(".session-card").first().waitFor();
  await page.getByTestId("session-create-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor();
  await page.getByTestId("new-session-name-input").fill("Background copy");
  await page.getByTestId("new-session-next-button").click();
  await page.getByTestId("new-session-next-button").click();
  await page.getByTestId("new-session-worktree-select").selectOption("new");
}

test("worktree creation accepts messages and attachments, then sends them in order without losing the draft", { timeout: 90_000 }, async (t) => {
  const fixture = await nativeUiFixture(t);
  const { page } = fixture;
  const prompts: Array<{ message: string; files: Array<{ name: string; data: string }> }> = [];
  const conversationSockets: string[] = [];
  const delivered = Promise.withResolvers<void>();
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    if (!new URL(socket.url()).searchParams.has("sessionPath")) { socket.connectToServer(); return; }
    conversationSockets.push(socket.url());
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const payload = JSON.parse(String(message));
      // Keep the real ready handshake, but never send a prompt to a live model.
      if (payload.type === "prompt") {
        prompts.push(payload);
        socket.send(JSON.stringify({ type: "userMessage", text: payload.message }));
        if (prompts.length === 2) delivered.resolve();
      } else server.send(message);
    });
  });
  await openNewWorktreeDialog(fixture);
  const socketsBeforeCreation = conversationSockets.length;
  let releaseCopy!: () => void;
  const copyHeld = new Promise<void>((resolve) => { releaseCopy = resolve; });
  await page.route("**/api/projects/*/worktrees", async (route) => {
    if (route.request().method() === "POST") await copyHeld;
    await route.fallback();
  });
  try {
    await page.getByTestId("new-session-name-start-button").click();
    await page.locator("#newSessionNameDialog[open]").waitFor({ state: "hidden" });
    await page.locator("#messages").getByText("Creating worktree…").waitFor();
    assert.equal(await page.locator("#sessionTitle").innerText(), "Background copy");
    assert.equal(await page.locator("#messageInput").isEnabled(), true, "copying must not disable typing");
    await page.locator("#messageInput").fill("First queued message");
    await page.locator("#messageInput").press("Enter");
    await page.getByTestId("worktree-waiting-message").filter({ hasText: "First queued message" }).waitFor();
    await page.locator("#attachmentInput").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("queued attachment") });
    await page.locator("#messageInput").fill("Second queued message");
    await page.locator("#sendButton").click();
    await page.getByTestId("worktree-waiting-message").filter({ hasText: "Second queued message" }).waitFor();
    await page.locator("#messageInput").fill("Unsent draft");
    assert.equal(await page.getByTestId("worktree-waiting-message").count(), 2);
    assert.equal(conversationSockets.length, socketsBeforeCreation, "no conversation starts in the project folder while copying");
    assert.equal(prompts.length, 0, "messages wait until the worktree exists");
    await page.evaluate(async () => {
      const { state } = await import("/app/state.js");
      const { openListedSession } = await import("/app/reviews.js");
      const existing = state.sessions.find((session: { id: string; draft?: boolean }) => session.id !== state.activeSessionId && !session.draft);
      await openListedSession(existing);
    });
    await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
    await page.locator("#messageInput").fill("Other conversation draft");
    await page.locator("#sessionList .list-row", { hasText: "Background copy" }).locator(".session-card").click();
    assert.equal(await page.getByTestId("worktree-waiting-message").count(), 2, "switching conversations preserves waiting messages");
    assert.equal(await page.locator("#messageInput").inputValue(), "Unsent draft", "each conversation keeps its own draft");
    releaseCopy();
    await page.waitForFunction(() => document.querySelectorAll("#messages .message.user").length === 2 && !document.querySelector('[data-testid="worktree-waiting-message"]'));
    await delivered.promise;
    assert.deepEqual(prompts.map((prompt) => prompt.message), ["First queued message", "Second queued message"], "queued messages are sent once, in order");
    assert.equal(prompts[1].files[0].name, "notes.txt");
    assert.equal(Buffer.from(prompts[1].files[0].data, "base64").toString(), "queued attachment");
    assert.equal(await page.locator("#messageInput").inputValue(), "Unsent draft", "connecting preserves text not yet submitted");
    assert.ok(new URL(conversationSockets.at(-1)!).searchParams.get("worktreeId"), "the socket opens in the completed worktree");
  } finally {
    releaseCopy();
    await page.unroute("**/api/projects/*/worktrees");
  }
});

test("a failed worktree copy keeps waiting messages and the unsent draft without sending elsewhere", { timeout: 90_000 }, async (t) => {
  const fixture = await nativeUiFixture(t);
  const { page } = fixture;
  let conversationSockets = 0;
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    const server = socket.connectToServer();
    if (new URL(socket.url()).searchParams.has("sessionPath")) conversationSockets += 1;
    socket.onMessage((message) => {
      const payload = JSON.parse(String(message));
      if (payload.type !== "prompt") server.send(message);
    });
  });
  await openNewWorktreeDialog(fixture);
  const before = conversationSockets;
  const copy = Promise.withResolvers<void>();
  await page.route("**/api/projects/*/worktrees", async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    await copy.promise;
    await route.fulfill({ status: 500, json: { error: "Copy failed for test" } });
  });
  try {
    await page.getByTestId("new-session-name-start-button").click();
    await page.locator("#messages").getByText("Creating worktree…").waitFor();
    await page.locator("#messageInput").fill("Keep this waiting message");
    await page.locator("#messageInput").press("Enter");
    await page.getByTestId("worktree-waiting-message").waitFor();
    await page.locator("#messageInput").fill("Keep this unsent draft");
    copy.resolve();
    await page.getByTestId("turn-error").filter({ hasText: "Copy failed for test" }).waitFor();
    assert.match(await page.getByTestId("worktree-waiting-message").innerText(), /Keep this waiting message/);
    assert.equal(await page.locator("#messageInput").inputValue(), "Keep this unsent draft");
    assert.equal(await page.locator("#messageInput").isEnabled(), true);
    assert.equal(await page.locator("#sendButton").isEnabled(), false);
    assert.equal(conversationSockets, before, "a failed copy never falls back to the project folder");
  } finally {
    copy.resolve();
    await page.unroute("**/api/projects/*/worktrees");
  }
});
