import assert from "node:assert/strict";
import test from "node:test";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture, openBobChat } from "./native-ui-fixture.js";

test("Bob's floating chat stays above a conversation popup it overlaps", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(node.url);
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Thread-Based Agent Builder" }) }).first().click();
  await page.locator("#messages .message.assistant").first().waitFor();
  await page.evaluate(async () => {
    const { setMobileView } = await import("/app/layout.js");
    setMobileView("control");
  });
  await openBobChat(page);
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const { openConversation } = await import("/app/control-center.js");
    const card = { projectId: state.activeProjectId, conversationId: state.activeConversationId || state.activeSessionId };
    await openConversation(card);
  });
  await page.locator("body.bob-desk.view-control.control-popup").waitFor();
  // Put the chat window on top of the popup's box, then ask which element is under the chat's middle.
  const covered = await page.evaluate(() => {
    const chat = document.querySelector<HTMLElement>("#controlChat")!;
    const popup = document.querySelector<HTMLElement>("#chatPanel")!.getBoundingClientRect();
    chat.style.left = `${popup.left + 20}px`;
    chat.style.top = `${popup.top + 20}px`;
    const box = chat.getBoundingClientRect();
    return !chat.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  });
  assert.equal(covered, false, "the conversation popup must not paint over Bob's chat window");
});
