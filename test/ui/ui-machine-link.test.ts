import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, freePort, screenshotPath, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";
import { waitForAssertion } from "../async-assertion.js";

async function openCluster(browser: Browser, environment: DevEnvironment, node: SeededNode, errors: string[]): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-cluster").click();
  await page.getByTestId("cluster-content").waitFor();
  return page;
}

// Settings > Cluster on two real nodes behind a relay: one makes the link, the other pastes it.
test("Add a twin makes one link, and Use a link on the other machine shows each step it took", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-machine-link-"));
  const servers: ChildProcess[] = [];
  let browser: Browser | undefined;
  try {
    const [relayEnv, macEnv, newEnv] = await Promise.all(["relay", "mac", "new"].map((name) => seedDevEnvironment(path.join(root, name), 1)));
    const [relay, mac, added] = [relayEnv.nodes[0], macEnv.nodes[0], newEnv.nodes[0]];
    servers.push(await startDevNode(relayEnv, relay), await startDevNode(macEnv, mac), await startDevNode(newEnv, added));
    const [relaySession, macSession, addedSession] = await Promise.all([signIn(relayEnv, relay), signIn(macEnv, mac), signIn(newEnv, added)]);
    const serving = await fetch(`${relay.url}/api/relay/serving`, { method: "PUT", headers: { Cookie: relaySession.cookie, "x-csrf-token": relaySession.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, origin: `http://localhost:${relay.port}`, environment: "test", requestsEnabled: true, maxMachines: 10, monthlyCapGb: 0, alertTopic: "", ownMachinesOnly: false }) });
    assert.equal(serving.status, 204);
    const token = await api<{ link: string }>(relay, relaySession, "POST", "/relay/serving/tokens", { label: "mac" });
    assert.equal((await api(mac, macSession, "POST", "/relays", { link: token.body.link })).status, 201);
    await waitForAssertion(async () => assert.equal((await api<{ relays: Array<{ connected: boolean }> }>(mac, macSession, "GET", "/relays")).body.relays[0]?.connected, true), 20_000);
    assert.equal((await api(mac, macSession, "PUT", "/cluster/node", { name: "MacBook", url: "" })).status, 200);
    assert.equal((await api(added, addedSession, "PUT", "/cluster/node", { name: "HomeMac", url: "" })).status, 200);
    assert.equal((await api(mac, macSession, "POST", "/clusters", { name: "Home cluster" })).status, 201);

    browser = await launchChrome({ headless: process.env.HEADED !== "1" });
    const errors: string[] = [];

    const macPage = await openCluster(browser, macEnv, mac, errors);
    // Someone else's machine: clusters to tick, and no twin.
    await macPage.getByTestId("machine-invite-reveal").click();
    await macPage.getByTestId("machine-add-form").waitFor();
    assert.equal(await macPage.getByTestId("machine-cluster-choice").count(), 1);
    assert.match(await macPage.getByTestId("machine-form-intro").innerText(), /someone else's machine/);
    assert.equal(await macPage.getByTestId("machine-invite-reveal").getAttribute("aria-expanded"), "true");

    // Another machine of yours: nothing to choose, it joins every cluster this machine is in.
    await macPage.getByTestId("machine-add-reveal").click();
    assert.equal((await macPage.getByTestId("machine-add-reveal").innerText()).trim(), "Add a twin");
    assert.equal(await macPage.getByTestId("machine-add-reveal").getAttribute("aria-expanded"), "true");
    assert.equal(await macPage.getByTestId("machine-invite-reveal").getAttribute("aria-expanded"), "false");
    assert.equal(await macPage.getByTestId("machine-clusters").isVisible(), false);
    assert.match(await macPage.getByTestId("machine-form-intro").innerText(), /twin of MacBook.*joins the cluster this machine is in \(Home cluster\)/);
    await macPage.getByTestId("machine-create-button").click();
    await macPage.getByTestId("confirm-accept-button").click();
    await macPage.getByTestId("machine-link-result").waitFor();
    const link = await macPage.getByTestId("machine-link-output").inputValue();
    assert.match(link, /\/join#machine-v1\./);
    const summary = await macPage.getByTestId("machine-link-summary").innerText();
    assert.match(summary, /becomes a twin of MacBook/);
    assert.match(summary, /joins the cluster Home cluster/);
    assert.match(summary, /joins the relay localhost/);
    assert.equal(await macPage.getByTestId("machine-link-notes").isVisible(), false, "nothing is left to do by hand");
    await macPage.screenshot({ path: screenshotPath(root, "machine-link-created") });

    const newPage = await openCluster(browser, newEnv, added, errors);
    await newPage.getByTestId("cluster-join-reveal").click();
    assert.equal((await newPage.getByTestId("cluster-join-reveal").innerText()).trim(), "Use a link");
    await newPage.getByTestId("cluster-join-link-input").fill(link);
    await newPage.getByTestId("cluster-join-button").click();
    await newPage.getByTestId("confirm-accept-button").waitFor();
    assert.match(await newPage.locator("#confirmMessage").innerText(), /becomes a twin of MacBook/);
    await newPage.getByTestId("confirm-accept-button").click();
    // Every step went through: one closing message, and the form puts itself away.
    await newPage.locator(".toast", { hasText: "All done. This machine is now a twin of MacBook and in Home cluster." }).waitFor({ timeout: 60_000 });
    await waitForAssertion(async () => assert.equal(await newPage.getByTestId("cluster-join-form").isVisible(), false));
    assert.equal(await newPage.getByTestId("cluster-join-reveal").getAttribute("aria-expanded"), "false");
    await newPage.getByTestId("cluster-map-twin").first().waitFor();
    assert.match(await newPage.getByTestId("cluster-map-twin").first().innerText(), /MacBook/);
    await newPage.getByTestId("cluster-item").first().waitFor();
    await newPage.screenshot({ path: screenshotPath(root, "machine-link-used") });

    // The first machine sees its new twin without a reload of its own.
    await macPage.getByTestId("machine-add-cancel").click();
    await waitForAssertion(async () => {
      await macPage.getByTestId("settings-tab-relay").click();
      await macPage.getByTestId("settings-tab-cluster").click();
      assert.equal(await macPage.getByTestId("cluster-map-twin").count(), 1);
    }, 30_000);

    // A machine nobody has set up takes the link on its welcome screen, with the administrator's name and password.
    const freshPort = await freePort(), freshHome = path.join(root, "fresh", "home");
    const fresh: SeededNode = { key: "fresh", name: "Fresh", port: freshPort, url: `http://127.0.0.1:${freshPort}`, dataDir: path.join(root, "fresh", "data"), cookieName: "mb_session_dev_fresh", nodeId: "", projects: [] };
    await mkdir(fresh.dataDir, { recursive: true });
    await mkdir(freshHome, { recursive: true });
    servers.push(await startDevNode({ ...newEnv, home: freshHome, nodes: [fresh] }, fresh));
    const second = await api<{ link: string }>(mac, macSession, "POST", "/machine-links", { own: true, clusterIds: [], confirmOwnedData: true });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const freshPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
    freshPage.setDefaultTimeout(20_000);
    freshPage.on("pageerror", (error) => errors.push(error.message));
    await freshPage.goto(fresh.url);
    await freshPage.getByTestId("login-machine-link-input").waitFor();
    await freshPage.getByTestId("login-username-input").fill("owner");
    await freshPage.getByTestId("login-email-input").fill("owner@example.test");
    await freshPage.getByTestId("login-new-password-input").fill("a-long-enough-password-1");
    await freshPage.getByTestId("login-machine-link-input").fill(second.body.link);
    await freshPage.screenshot({ path: screenshotPath(root, "machine-link-welcome") });
    await freshPage.getByTestId("login-submit-button").click();
    await freshPage.getByTestId("confirm-accept-button").waitFor({ timeout: 40_000 });
    assert.match(await freshPage.locator("#confirmMessage").innerText(), /becomes a twin of MacBook and HomeMac/);
    await freshPage.getByTestId("confirm-accept-button").click();
    await freshPage.locator(".toast", { hasText: "All done." }).waitFor({ timeout: 90_000 });
    await waitForAssertion(async () => assert.equal(await freshPage.getByTestId("cluster-join-form").isVisible(), false));
    await freshPage.getByTestId("cluster-map-twin").first().waitFor();
    assert.equal(await freshPage.getByTestId("settings-tab-cluster").getAttribute("aria-selected"), "true");
    // Signed in, the link field is gone from the sign-in form.
    assert.equal(await macPage.getByTestId("login-machine-link-input").isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await Promise.all(servers.map(stopDevNode));
    if (!process.env.KEEP_SCREENSHOTS) await rm(root, { recursive: true, force: true });
  }
});
