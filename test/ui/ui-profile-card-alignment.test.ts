import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { api, signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("profiles are rows whose actions stay on the right when one has a sign-in result", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const session = await signIn(environment, node);
  const ids: string[] = [];
  for (const label of ["Work account", "Personal account"]) {
    const created = await api<{ profile: { id: string } }>(node, session, "POST", "/provider-profiles", { provider: "openai-codex", label });
    assert.equal(created.status, 201);
    ids.push(created.body.profile.id);
  }
  const saveCredential = async (id: string) => {
    const auth = path.join(node.dataDir, "provider-profile-auth", id, "auth.json");
    await mkdir(path.dirname(auth), { recursive: true, mode: 0o700 });
    await writeFile(auth, JSON.stringify({ "openai-codex": { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
  };
  await saveCredential(ids[0]);
  // Complete the external OAuth step locally; status reads the real fixture credential.
  await page.route(`${node.url}/api/provider-profiles/${ids[1]}/login`, async (route) => {
    assert.equal(route.request().method(), "POST");
    await saveCredential(ids[1]);
    await route.fulfill({ json: { login: { state: "complete", message: "Signed in on this node" } } });
  });

  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-connections").click();
  const cards = page.getByTestId("provider-profile-row");
  const personal = cards.filter({ hasText: "Personal account" });
  await personal.getByTestId("provider-profile-status").filter({ hasText: "Not signed in" }).waitFor();
  await personal.getByTestId("provider-profile-signin").click();
  await personal.getByTestId("provider-profile-login").filter({ hasText: "Signed in on this node" }).waitFor();
  await personal.getByTestId("provider-profile-signout").waitFor();
  assert.equal(await cards.filter({ hasText: "Work account" }).getByTestId("provider-profile-login").isVisible(), false, "only the newly signed-in card has the extra result");

  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const boxes = await cards.evaluateAll((items) => items.map((item) => {
      const card = item.getBoundingClientRect();
      const actions = item.querySelector(":scope > .profile-actions")!.getBoundingClientRect();
      return { left: card.left, right: card.right, top: card.top, bottom: card.bottom, actionsRight: actions.right };
    }));
    assert.equal(boxes.length, 2);
    assert.ok(Math.abs(boxes[0].left - boxes[1].left) < 1 && Math.abs(boxes[0].right - boxes[1].right) < 1, `rows share one width at ${width}px: ${JSON.stringify(boxes)}`);
    assert.ok(boxes[1].top >= boxes[0].bottom - 1, `rows stack at ${width}px: ${JSON.stringify(boxes)}`);
    if (width >= 1200) assert.ok(boxes.every((box) => box.right - box.actionsRight < 24), `actions sit at the right end of their row at ${width}px: ${JSON.stringify(boxes)}`);
  }
});
