import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";
import { backToList, dismissAddress, editorReady, editorTab, fillSetup, newAutomation, saveAutomation, signInToApp } from "./automation-editor-driver.js";

test("webhooks and schedules expose creation machines and transfer controls", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automation-machines-"));
  const servers: ChildProcess[] = [];
  const browser = await launchChrome({ headless: true });
  try {
    const env = await seedDevEnvironment(root, 2);
    const [a, b] = env.nodes;
    for (const project of b.projects) {
      const skill = path.join(project.path, ".agents", "skills", "remote-review");
      await mkdir(skill, { recursive: true });
      await writeFile(path.join(skill, "SKILL.md"), "---\nname: remote-review\ndescription: Review remote references.\n---\n");
    }
    for (const node of env.nodes) servers.push(await startDevNode(env, node));
    const auth = await signIn(env, a);
    await pairTwinNodes(env);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => console.error("Browser error:", error.message));
    await signInToApp(page, a.url, env.username, env.password);
    await page.getByTestId("projects-open-control-center-button").click();
    await page.getByTestId("control-tab-automations").waitFor({ state: "attached" });
    await page.getByTestId("workspace-automations-button").click();

    const chooseMachine = async (nodeId: string) => {
      await editorTab(page, "run");
      await page.getByTestId("automation-machine").selectOption(nodeId);
      await page.waitForFunction((id) => (document.querySelector('[data-testid="automation-machine"]') as HTMLSelectElement).value === id && !document.querySelector<HTMLButtonElement>('[data-testid="automation-save"]')!.disabled, nodeId);
    };
    const transferTo = async (id?: string) => {
      await page.getByTestId("automation-menu").click();
      await page.getByTestId("automation-transfer").click();
      const destination = page.getByTestId("automation-transfer-machine");
      await destination.waitFor();
      if (id) await destination.selectOption(id);
      await page.getByTestId("automation-transfer-confirm").click();
      await page.getByTestId("automation-transfer-confirm").click();
    };

    // A webhook created on the other machine keeps its typed name, then moves here and gets a new address.
    await newAutomation(page);
    await page.getByTestId("automation-trigger-webhook").click();
    await fillSetup(page, "Remote machine hook", "Triage the call");
    await chooseMachine(b.nodeId);
    await editorTab(page, "setup");
    assert.equal(await page.getByTestId("automation-setup-name").inputValue(), "Remote machine hook");
    await saveAutomation(page);
    await dismissAddress(page);
    await editorTab(page, "context");
    const inventory = page.waitForResponse(response => /\/skills\?inventory=/.test(response.url()));
    await page.getByTestId("automation-context-segment-skills").click();
    const result = await inventory;
    assert.equal(result.status(), 200, await result.text());
    assert.equal(new URL(result.url()).searchParams.get("nodeId"), b.nodeId);
    await page.getByTestId("automation-skill-search-input").fill("remote-review");
    await page.getByTestId("automation-skill-import-existing-button").click();
    await page.getByTestId("automation-skill-available").getByText("Added", { exact: true }).waitFor();
    await transferTo();
    await page.getByTestId("automation-address").first().waitFor();
    await dismissAddress(page);
    const hooks = await api<{ automations: Array<{ name: string; trigger: string; ownerNodeId: string }> }>(a, auth, "GET", "/automations");
    const hook = hooks.body.automations.find(item => item.name === "Remote machine hook");
    assert.equal(hook?.trigger, "webhook");
    assert.equal(hook?.ownerNodeId, a.nodeId);
    await backToList(page);

    // A schedule created on the other machine moves here without an address.
    await newAutomation(page);
    await fillSetup(page, "Move schedule", "Report");
    await chooseMachine(b.nodeId);
    assert.equal(await page.getByTestId("automation-machine").inputValue(), b.nodeId);
    await saveAutomation(page);
    await transferTo();
    await page.waitForFunction(() => /Moved to/.test(document.querySelector('[data-testid="automation-status"]')?.textContent ?? ""));
    assert.equal(await page.getByTestId("automation-address").count(), 0, "a schedule has no address");
    const schedules = await api<{ automations: Array<{ name: string; ownerNodeId: string }> }>(a, auth, "GET", "/automations");
    assert.equal(schedules.body.automations.find(item => item.name === "Move schedule")?.ownerNodeId, a.nodeId);
  } finally {
    await browser.close();
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
