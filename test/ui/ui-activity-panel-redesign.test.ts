// End-to-end browser coverage for the redesigned Activity panel:
// - 4 top-level tabs: Activity (unified monitor), Ask (renamed from btw), Git (all-on-screen + sub-tabs), Story (top-level)
// - Files moved to top header ⋯ menu
// - Podcast playback moved to top header bar
// - Inline diffs, inline pipeline jobs/logs, inline PR checks + Explain in Story (no modal required)
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("redesigned Activity panel: inline Git hub, top-level Story, Ask, unified Activity monitor, Files in ⋯, and Podcast in top bar", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-activity-redesign-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  const browser = await launchChrome({ headless: true, env: { ...process.env, HOME: environment.home } });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => { pageErrors.push(error.message); console.error(error.message); });
    page.setDefaultTimeout(15_000);

    // Mock Git, GitHub (PRs & Pipelines), and saved Story endpoints so the inline flows work deterministically.
    await page.route("**/api/projects/*/git/**", async (route) => {
      const url = new URL(route.request().url());
      const op = url.searchParams.get("op");
      if (url.pathname.endsWith("/status")) {
        return route.fulfill({
          json: {
            branch: "main", upstream: "origin/main", ahead: 1, behind: 2, clean: false,
            staged: [{ path: "backend/evals/test_harness.py", kind: "modified" }],
            unstaged: [{ path: "backend/app/response_parser.py", kind: "modified" }],
            untracked: [],
          },
        });
      }
      if (url.pathname.endsWith("/scope")) {
        return route.fulfill({ json: { paths: ["backend/app/response_parser.py", "backend/evals/test_harness.py"], lastHarness: "claude" } });
      }
      if (url.pathname.endsWith("/diff")) {
        return route.fulfill({
          json: {
            binary: false,
            truncated: false,
            patch: "@@ -84,4 +84,5 @@\n def parse(payload):\n-    if slots is None:\n+    if not slots:\n+        return clarify(payload)\n",
          },
        });
      }
      if (url.pathname.endsWith("/github") && op === "runs") {
        return route.fulfill({
          json: {
            runs: {
              workflow_runs: [
                { id: 942, run_number: 942, name: "CI / Backend Evals", status: "in_progress", conclusion: null, head_branch: "main", head_sha: "9f3c2a100", event: "push", created_at: new Date().toISOString() },
                { id: 941, run_number: 941, name: "Webhook Smoke Tests", status: "completed", conclusion: "failure", head_branch: "main", head_sha: "4d18b0e00", event: "pull_request", updated_at: new Date().toISOString() },
              ],
            },
          },
        });
      }
      if (url.pathname.endsWith("/github") && op === "run") {
        return route.fulfill({
          json: {
            run: { id: 941, name: "Webhook Smoke Tests" },
            jobs: [{ id: 5001, name: "webhook-retry-test", status: "completed", conclusion: "failure", steps: [{ number: 3, name: "Run pytest", conclusion: "failure" }] }],
          },
        });
      }
      if (url.pathname.endsWith("/github") && op === "log") {
        return route.fulfill({
          json: {
            job: { id: 5001, name: "webhook-retry-test", steps: [{ number: 3, name: "Run pytest", conclusion: "failure" }] },
            steps: [{ number: 3, text: "FAILED test_webhook.py\nAssertionError: expected 200 got 502" }],
          },
        });
      }
      if (url.pathname.endsWith("/github") && op === "pulls") {
        return route.fulfill({
          json: {
            pulls: [{ number: 418, title: "Pre-sale booking orchestrator", state: "open", draft: false, head: { ref: "feat/presale" }, base: { ref: "main" }, user: { login: "ilia" }, updated_at: new Date().toISOString(), html_url: "https://github.com/org/repo/pull/418" }],
          },
        });
      }
      if (url.pathname.endsWith("/github") && op === "pull") {
        return route.fulfill({
          json: {
            pull: { number: 418, title: "Pre-sale booking orchestrator", body: "Handles empty availability slots cleanly." },
            checks: { check_runs: [{ name: "unit-tests", status: "completed", conclusion: "success" }] },
          },
        });
      }
      if (url.pathname.endsWith("/story-latest")) {
        return route.fulfill({
          json: {
            commits: [],
            latest: {
              thread: { id: "story-1", updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
              freshness: { fresh: true },
              saved: {
                facts: { files: [{ path: "backend/app/response_parser.py", add: 12, del: 3 }] },
                story: {
                  title: "Graceful fallback for empty slots",
                  overview: { what: "Prevents crashes when availability slots are empty.", why: "Unlinked calendars return [] instead of None.", notice: ["Adds fallback prompt"] },
                  diagram: { nodes: [{ id: "a", label: "Lookup slots", file: "knowledge.py" }, { id: "b", label: "Check empty list", kind: "decision", file: "response_parser.py" }], edges: [{ from: "a", to: "b", label: "slots = []" }] },
                  timeline: [{ title: "Fixed empty list check", turns: [1, 2], summary: "Replaced is None check." }],
                  examples: [{ title: "Unlinked calendar", kind: "Edge case", result: "Asks customer for preferred time." }],
                  implementation: { what: { "backend/app/response_parser.py": "Switched None check to truthiness guard." }, decisions: [], checks: [] },
                },
              },
            },
          },
        });
      }
      return route.continue();
    });

    await page.addInitScript(() => localStorage.setItem("joint-bob-start-view", "last"));
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.locator("#loginDialog[open]").waitFor();
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator("#loginDialog[open]").waitFor({ state: "detached" });

    await page.getByTestId("workspace-projects-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.locator(".session-card").first().click();
    await page.locator("body.view-chat").waitFor();
    await page.locator("#messages .message.assistant").first().waitFor();
    if (!(await page.getByTestId("activity-panel").isVisible())) await page.getByTestId("chat-activity-toggle").click();

    // 1. Podcast playback sits in the top header; Files lives in the top ⋯ menu.
    assert.equal(await page.getByTestId("chat-head-actions").getByTestId("activity-overview-button").isVisible(), true);
    await page.getByTestId("chat-more-button").click();
    assert.equal(await page.getByTestId("chat-files-button").isVisible(), true, "Files moved to top ⋯ menu");
    await page.getByTestId("chat-more-button").click();

    // 2. Git tab defaults to All showing Pipelines, PRs and Changed files inline with no modal.
    await page.getByTestId("details-git-tab").click();
    await page.getByTestId("details-git-run").first().waitFor();
    assert.match(await page.getByTestId("details-git-pipelines-card").innerText(), /CI \/ Backend Evals/);
    assert.match(await page.getByTestId("details-git-prs-card").innerText(), /#418 Pre-sale booking orchestrator/);
    assert.match(await page.getByTestId("details-git-changes-card").innerText(), /response_parser\.py/);

    // Expanding a failed pipeline shows jobs & error log inline without a modal.
    await page.getByTestId("details-git-run").nth(1).click();
    await page.locator("#detailsGitContent .ws-code-block", { hasText: "AssertionError: expected 200 got 502" }).waitFor();
    assert.equal(await page.locator("#gitReviewDialog[open]").count(), 0, "no modal opened for pipeline log");

    // Expanding a changed file shows its inline diff and Ask AI switches to Ask tab with prompt prefilled.
    await page.getByTestId("details-file").filter({ hasText: "response_parser.py" }).click();
    await page.getByTestId("details-inline-diff").waitFor();
    assert.match(await page.getByTestId("details-inline-diff").innerText(), /if not slots:/);
    assert.equal(await page.locator("#gitReviewDialog[open]").count(), 0, "no modal opened for file diff");
    await page.getByTestId("details-inline-diff").getByRole("button", { name: "Ask AI" }).click();
    await page.getByTestId("conversation-chat").waitFor();
    assert.match(await page.getByTestId("conversation-chat-input").inputValue(), /response_parser\.py/);

    // 3. Expanding a PR and clicking Explain in Story switches straight to top-level Story inline.
    await page.getByTestId("details-git-tab").click();
    await page.getByTestId("details-git-pr").first().click();
    await page.getByRole("button", { name: "Explain in Story" }).click();
    await page.getByTestId("details-story").waitFor();
    assert.match(await page.getByTestId("details-story-host").innerText(), /Graceful fallback for empty slots/);
    assert.equal(await page.locator("#gitReviewDialog[open]").count(), 0, "Story rendered inline at top level");

    assert.deepEqual(pageErrors, [], "no browser runtime errors");
  } finally {
    await browser.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
