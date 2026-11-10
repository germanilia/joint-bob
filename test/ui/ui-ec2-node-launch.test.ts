import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("the new-conversation dialog launches an EC2 node with the ticked AWS account", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ec2-ui-"));
  const log = path.join(root, "aws.log");
  // A stand-in `aws`, found first on the node's PATH, so no real AWS account is touched.
  await writeFile(path.join(root, "aws"), `#!/bin/sh\necho "$AWS_ACCESS_KEY_ID $AWS_REGION $*" >> "${log}"\necho '{"Instances":[{"InstanceId":"i-0abc1234def567890","State":{"Name":"pending"}}]}'\n`);
  await chmod(path.join(root, "aws"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}:${previousPath}`;
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    const admin = await signIn(environment, node);
    await api(node, admin, "POST", "/secrets/accounts", { label: "Test AWS", provider: "aws", replicate: false, variables: [{ name: "AWS_ACCESS_KEY_ID", kind: "value", value: "AKIAUITESTKEY" }, { name: "AWS_SECRET_ACCESS_KEY", kind: "value", value: "ui-secret" }] });
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.getByTestId("session-create-button").click();
    await page.getByTestId("new-session-name-dialog").waitFor({ state: "visible" });
    await page.getByTestId("new-session-next-button").click();
    await page.getByTestId("new-session-next-button").click();
    await page.getByTestId("new-session-panel-3").waitFor({ state: "visible" });
    await page.getByTestId("new-session-ec2").locator("summary").click();

    await page.getByTestId("new-session-ec2-button").click();
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Tick exactly one AWS secret account"));

    await page.getByTestId("conversation-secrets-list").getByText("Test AWS").click();
    await page.getByTestId("new-session-ec2-region").fill("eu-west-1");
    await page.getByTestId("new-session-ec2-key").fill("my-key");
    await page.getByTestId("new-session-ec2-button").click();
    await page.getByTestId("new-session-ec2-status").getByText("Launched i-0abc1234def567890 (pending)").waitFor();
    assert.match(await readFile(log, "utf8"), /^AKIAUITESTKEY eu-west-1 ec2 run-instances .*--key-name my-key/s);
  } finally {
    process.env.PATH = previousPath;
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
