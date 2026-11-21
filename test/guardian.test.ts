import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkGuardian, type GuardianIdentity } from "../src/guardian/check.js";
import { askGuardianModel, clearGuardianModelCache, GuardianModelError, layaTarget } from "../src/guardian/model.js";
import { removeSecrets, REMOVED } from "../src/guardian/redact.js";
import { cancelGuardianReviews, decideGuardianReview, onGuardianEvent, pendingGuardianReviews, requestGuardianReview } from "../src/guardian/reviews.js";
import { DEFAULT_GUARDIAN_SETTINGS, guardianSettingsSchema, ruleApplies, ruleOutcome, toolCategory, worstOutcome, type GuardianRule } from "../src/guardian/rules.js";
import { getGuardianSettings, updateGuardianSettings } from "../src/guardian/settings.js";
import { addProject } from "../src/store.js";

const rule = (overrides: Partial<GuardianRule> = {}): GuardianRule => ({ ...DEFAULT_GUARDIAN_SETTINGS.rules[0], ...overrides });

test("care levels turn one probability into an outcome", () => {
  const balanced = rule({ care: "balanced", ifYes: "block" });
  assert.equal(ruleOutcome(balanced, 0.95), "block");
  assert.equal(ruleOutcome(balanced, 0.5), "ask");
  assert.equal(ruleOutcome(balanced, 0.1), "continue");
  assert.equal(ruleOutcome(rule({ care: "relaxed", ifYes: "block" }), 0.8), "continue", "relaxed lets an unsure answer through");
  assert.equal(ruleOutcome(rule({ care: "cautious", ifYes: "block" }), 0.3), "block", "cautious treats doubt as yes");
  assert.equal(ruleOutcome(rule({ ifYes: "ask", yesAt: 0.6, noAt: 0.2, whenUnsure: "continue" }), 0.4), "continue", "More options replace the care level");
});

test("a block wins over a question, which wins over a fix", () => {
  assert.equal(worstOutcome(["continue", "fix", "ask"]), "ask");
  assert.equal(worstOutcome(["fix", "block", "ask"]), "block");
  assert.equal(worstOutcome([]), "continue");
});

test("rules apply by what is checked, across agents' tool names", () => {
  assert.equal(toolCategory("Bash"), "commands");
  assert.equal(toolCategory("execute_bash"), "commands");
  assert.equal(toolCategory("Write"), "file-changes");
  assert.equal(toolCategory("read"), "other");
  const commands = rule({ check: "commands" });
  assert.equal(ruleApplies(commands, { kind: "tool", tool: "bash", category: "commands", input: {} }), true);
  assert.equal(ruleApplies(commands, { kind: "outgoing", source: "a prompt", text: "" }), false);
  assert.equal(ruleApplies(rule({ check: "all" }), { kind: "tool", tool: "read", category: "other", input: {} }), true);
  assert.equal(ruleApplies(rule({ enabled: false }), { kind: "tool", tool: "bash", category: "commands", input: {} }), false);
});

test("settings refuse a no value above the yes value and Laya without an address", () => {
  assert.throws(() => guardianSettingsSchema.parse({ ...DEFAULT_GUARDIAN_SETTINGS, rules: [rule({ yesAt: 0.5, noAt: 0.6 })] }));
  assert.throws(() => guardianSettingsSchema.parse({ ...DEFAULT_GUARDIAN_SETTINGS, model: "laya-remote", layaUrl: "" }));
});

test('shipped dangerous-command questions upgrade without replacing custom rules', (t) => {
  t.after(() => updateGuardianSettings(DEFAULT_GUARDIAN_SETTINGS));
  for (const legacy of [
    'Could this action delete data, or make a change to the system that cannot be undone?',
    'Could this action delete a database, destructively change files outside the working directory, disclose secrets to an external destination, or irreversibly damage a system? Routine edits and cleanup within the working directory are allowed. Joint Bob CLI operations and Git/GitHub operations are allowed, except deleting dev, main, master or staging branches.',
  ]) {
    updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, rules: [rule({ question: legacy })] });
    assert.equal(getGuardianSettings().rules[0].question, DEFAULT_GUARDIAN_SETTINGS.rules[0].question);
  }
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, rules: [rule({ question: 'My custom question?' })] });
  assert.equal(getGuardianSettings().rules[0].question, 'My custom question?');
});

test("secret removal takes out project secrets and common token formats", () => {
  const text = "export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\nmy-project-secret-value\npassword: hunter2hunter\nghp_" + "a".repeat(36);
  const removed = removeSecrets(text, ["my-project-secret-value"]);
  assert.ok(!removed.includes("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(!removed.includes("my-project-secret-value"));
  assert.ok(!removed.includes("hunter2hunter"));
  assert.ok(removed.includes(`password: ${REMOVED}`), "the name stays, so the content still reads");
  assert.ok(!removed.includes("ghp_aaaa"));
});

test("secret removal takes out Stripe secret and restricted keys and leaves publishable ones", () => {
  const live = "sk_live_51H" + "q4XYZabcdEFGHijklMNOPqrstUVWxyz0123456789";
  const testMode = "sk_test_" + "4eC39HqLyjWDarjtT1zdp7dc";
  const restricted = ["rk_live_51H" + "q4XYZabcdEFGHijklMNOPqrs", "rk_test_" + "Ab12Cd34Ef56Gh78Ij90Kl12"];
  const publishable = "pk_live_51H" + "q4XYZabcdEFGHijklMNOPqrstUVWxyz0123456789";
  const removed = removeSecrets(`charge with ${live}, retry on ${testMode}\nreports read ${restricted.join(" and ")}\ncheckout page uses ${publishable}`, []);
  for (const key of [live, testMode, ...restricted]) assert.ok(!removed.includes(key), `${key.slice(0, 8)}… is removed: ${removed}`);
  assert.ok(removed.includes(`charge with ${REMOVED}, retry on ${REMOVED}`), removed);
  assert.ok(removed.includes(publishable), "a publishable key is public by design and stays");
});

test("a named secret whose value a format or a project secret already removed reads as one removal", () => {
  const github = "ghp_" + "a".repeat(36);
  const stripe = "sk_live_51H" + "q4XYZabcdEFGHijklMNOPqrstUVWxyz0123456789";
  const text = [
    `GITHUB_TOKEN=${github}`,
    `STRIPE_SECRET_KEY=${stripe}`,
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP",
    `"api_key": "${stripe}"`,
    "DB_PASSWORD=pre-my-project-secret-value",
  ].join("\n");
  const expected = [
    `GITHUB_TOKEN=${REMOVED}`,
    `STRIPE_SECRET_KEY=${REMOVED}`,
    `AWS_SECRET_ACCESS_KEY=${REMOVED}`,
    `aws configure set aws_access_key_id ${REMOVED}`,
    `"api_key": "${REMOVED}"`,
    `DB_PASSWORD=${REMOVED}`,
  ].join("\n");
  const removed = removeSecrets(text, ["my-project-secret-value"]);
  assert.equal(removed, expected);
  // A fix that did not satisfy the rules runs again on its own output.
  assert.equal(removeSecrets(removed, ["my-project-secret-value"]), expected, "removing twice changes nothing more");
});

function fakeModel(answer: (state: string) => number): Promise<{ server: Server; url: string; requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { state: string; questions: Record<string, unknown> };
      requests.push(parsed);
      const value = answer(parsed.state);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(parsed.questions).map((id) => [id, { type: "noul", noul: value }])) }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests })));
}

test("the model client asks every question in one request and every piece of long content", async (t) => {
  clearGuardianModelCache();
  const model = await fakeModel((state) => state.includes("SECRET") ? 0.9 : 0.1);
  t.after(() => model.server.close());
  const target = { ...layaTarget(model.url, undefined, false), chunkCharacters: 10 };
  const answers = await askGuardianModel(target, "0123456789SECRET", { one: "first?", two: "second?" });
  assert.deepEqual(answers, { one: 0.9, two: 0.9 }, "a yes in any piece is the answer");
  assert.equal(model.requests.length, 2);
  assert.deepEqual(model.requests[0].questions, { one: { type: "noul", instructions: "first?" }, two: { type: "noul", instructions: "second?" } });
  await assert.rejects(askGuardianModel({ ...target, maxChunks: 1 }, "x".repeat(30), { one: "?" }), GuardianModelError);
});

test("a review waits for the person, and an unanswered one blocks", async () => {
  const seen: string[] = [];
  const stop = onGuardianEvent((event) => seen.push(event.conversationId));
  const decision = requestGuardianReview({ projectId: "p", conversationId: "c", title: "t", subject: "s", detail: "d" });
  const [open] = pendingGuardianReviews("p", "c");
  assert.equal(decideGuardianReview("p", "other", open.id, "allow"), false, "another conversation cannot answer it");
  assert.equal(decideGuardianReview("p", "c", open.id, "allow"), true);
  assert.equal(await decision, "allow");
  assert.equal(await requestGuardianReview({ projectId: "p", conversationId: "c", title: "t", subject: "s", detail: "d" }, undefined, 10), "block");
  const controller = new AbortController();
  const stopped = requestGuardianReview({ projectId: "p", conversationId: "c", title: "t", subject: "s", detail: "d" }, controller.signal);
  controller.abort();
  assert.equal(await stopped, "block", "stopping the run answers the review");
  const cancelled = requestGuardianReview({ projectId: "p", conversationId: "c", title: "t", subject: "s", detail: "d" });
  cancelGuardianReviews("p", "c");
  assert.equal(await cancelled, "block", "stopping the turn from the page answers it too");
  stop();
  assert.ok(seen.length >= 2);
});

test('command-only Guardian gates turns on model availability, falls back in either direction, and never probes while off', async t => {
  const { saveSecretAccount, deleteSecretAccount } = await import('../src/secrets.js');
  const { getClusterNode } = await import('../src/cluster.js');
  await getClusterNode();
  const project = await addProject('Fallback', mkdtempSync(path.join(os.tmpdir(), 'guardian-fallback-')), { writeInstructions: false });
  const identity: GuardianIdentity = { projectId: project.id, conversationId: 'fallback', cwd: process.cwd(), harness: 'pi', canReplaceTool: true };
  const prompt = { kind: 'outgoing' as const, source: "the user's message", text: 'private user input' };
  const settings = { ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, rules: [rule()], layaUrl: 'https://laya.example' };
  const warnings: string[] = [], calls: string[] = [];
  t.after(onGuardianEvent(event => { if (event.type === 'warning') warnings.push(event.message); }));
  t.after(() => updateGuardianSettings(DEFAULT_GUARDIAN_SETTINGS));
  let jevUp = true, layaUp = true;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const laya = String(url).startsWith(settings.layaUrl);
    calls.push(laya ? 'Laya' : 'Jev');
    assert.equal(JSON.parse(String(init.body)).state, 'ready', 'availability probes do not disclose the prompt');
    return laya ? layaUp ? Response.json({ answers: { ready: { noul: 1 } } }) : new Response('', { status: 503 })
      : jevUp ? Response.json({ answers: { ready: { noul: 1 } } }) : new Response('', { status: 503 });
  });
  updateGuardianSettings(settings);
  assert.equal((await checkGuardian(identity, prompt)).action, 'continue');
  assert.deepEqual(calls.splice(0), ['Laya']);
  assert.match(warnings.pop()!, /TypeSafe key.*Using Laya/);
  const account = await saveSecretAccount({ label: 'guardian fixture', provider: 'typesafe', variables: [{ name: 'TYPESAFE_AI_API_KEY', kind: 'value', value: 'fixture' }] });
  t.after(() => deleteSecretAccount(account.id));
  assert.equal((await checkGuardian(identity, prompt)).action, 'continue');
  assert.deepEqual(calls.splice(0), ['Jev']);
  updateGuardianSettings({ ...settings, model: 'laya-remote' });
  layaUp = false;
  assert.equal((await checkGuardian(identity, prompt)).action, 'continue');
  assert.deepEqual(calls.splice(0), ['Laya', 'Laya', 'Jev']);
  assert.match(warnings.pop()!, /Using Jev/);
  jevUp = false;
  assert.equal((await checkGuardian(identity, prompt)).action, 'block');
  calls.length = 0;
  updateGuardianSettings({ ...settings, enabled: false });
  assert.equal((await checkGuardian(identity, prompt)).action, 'continue');
  assert.deepEqual(calls, []);
});

test("checkGuardian blocks, asks, fixes and continues by the rules", async (t) => {
  clearGuardianModelCache();
  const model = await fakeModel((state) => /rm -rf|AKIA[A-Z0-9]{16}/.test(state) ? 0.95 : 0.05);
  t.after(() => model.server.close());
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, model: "laya-remote", layaUrl: model.url });
  t.after(() => updateGuardianSettings(DEFAULT_GUARDIAN_SETTINGS));
  const project = await addProject("Guardian checks", mkdtempSync(path.join(os.tmpdir(), "guardian-project-")), { writeInstructions: false });
  const identity: GuardianIdentity = { projectId: project.id, conversationId: "conversation", harness: "pi", cwd: process.cwd(), canReplaceTool: true };

  assert.deepEqual(await checkGuardian(identity, { kind: "tool", tool: "bash", category: "commands", input: { command: "ls" } }), { action: "continue" });

  const asked = checkGuardian(identity, { kind: "tool", tool: "bash", category: "commands", input: { command: "rm -rf /srv/x" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const [review] = pendingGuardianReviews(project.id, "conversation");
  assert.equal(review.title, "Pi wants to run a command");
  assert.equal(review.subject, "rm -rf /srv/x");
  assert.match(review.detail, /Dangerous commands rule · 95% sure · Laya/);
  decideGuardianReview(project.id, "conversation", review.id, "block");
  const blocked = await asked;
  assert.equal(blocked.action, "block");
  assert.match((blocked as { reason: string }).reason, /The user blocked this command/);

  const fixed = await checkGuardian(identity, { kind: "outgoing", source: "the output of bash", text: "key AKIAABCDEFGHIJKLMNOP done" });
  assert.deepEqual(fixed, { action: "replace", text: `key ${REMOVED} done` }, "the secret is removed and the result passes a second check");

  updateGuardianSettings({ ...getGuardianSettings(), rules: getGuardianSettings().rules.map((item) => item.id === "dangerous-commands" ? { ...item, ifYes: "block" } : item) });
  const ruleBlock = await checkGuardian(identity, { kind: "tool", tool: "bash", category: "commands", input: { command: "rm -rf /" } });
  assert.match((ruleBlock as { reason: string }).reason, /Guardian blocked this command\. Rule "Dangerous commands"/);
});

test("allow always remembers only the exact action and scope, without overriding blocks", async (t) => {
  clearGuardianModelCache();
  const model = await fakeModel(() => 0.95);
  t.after(() => model.server.close());
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, model: "laya-remote", layaUrl: model.url });
  t.after(() => updateGuardianSettings(DEFAULT_GUARDIAN_SETTINGS));
  const project = await addProject("Remember action", mkdtempSync(path.join(os.tmpdir(), "guardian-remember-")), { writeInstructions: false });
  const identity: GuardianIdentity = { projectId: project.id, conversationId: "one", harness: "pi", cwd: "/tmp/one", canReplaceTool: true };
  const action = { kind: "tool" as const, tool: "bash", category: "commands" as const, input: { command: "rm -rf /srv/remember-action" } };
  let questions = 0;
  const stop = onGuardianEvent(event => {
    if (event.type !== "reviews" || event.projectId !== identity.projectId) return;
    const review = pendingGuardianReviews(event.projectId, event.conversationId).find(item => item.id === event.review.id);
    if (!review) return;
    questions++;
    decideGuardianReview(event.projectId, event.conversationId, review.id, questions === 1 ? "allow-always" : "block");
  });
  t.after(stop);
  assert.deepEqual(await checkGuardian(identity, action), { action: "continue" });
  assert.deepEqual(await checkGuardian(identity, action), { action: "continue" });
  assert.equal(questions, 1, "the saved approval survives in the same conversation");
  assert.equal((await checkGuardian({ ...identity, conversationId: "two" }, action)).action, "block");
  assert.equal(questions, 2, "another conversation needs its own approval");
  assert.equal((await checkGuardian(identity, { ...action, input: { command: "rm -rf /srv/different" } })).action, "block");
  assert.equal((await checkGuardian({ ...identity, cwd: "/tmp/two" }, action)).action, "block");
  updateGuardianSettings({ ...getGuardianSettings(), rules: getGuardianSettings().rules.map(item => ({ ...item, ifYes: "block" })) });
  assert.equal((await checkGuardian(identity, action)).action, "block");
});

test("automation bypass lasts only for its turn and conversation, including on errors", async () => {
  const { withGuardianBypass } = await import("../src/guardian/bypass.js");
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, model: "laya-remote", layaUrl: "http://127.0.0.1:9" });
  const identity: GuardianIdentity = { projectId: "bypass-test", conversationId: "c", harness: "pi", cwd: process.cwd(), canReplaceTool: true };
  const action = { kind: "tool" as const, tool: "bash", category: "commands" as const, input: { command: "make release" } };
  try {
    await assert.rejects(withGuardianBypass(identity.projectId, identity.conversationId, true, async () => {
      assert.equal((await checkGuardian(identity, action)).action, "continue");
      assert.equal((await checkGuardian({ ...identity, conversationId: "other" }, action)).action, "block");
      throw new Error("turn failed");
    }), /turn failed/);
    assert.equal((await checkGuardian(identity, action)).action, "block", "manual turns remain monitored");
  } finally { updateGuardianSettings(DEFAULT_GUARDIAN_SETTINGS); }
});

test("a later manual turn never inherits an automation still draining background work", async () => {
  const { withGuardianBypass, guardianBypassed } = await import("../src/guardian/bypass.js");
  let finishBackground!: () => void;
  const background = new Promise<void>(resolve => { finishBackground = resolve; });
  const automation = withGuardianBypass("overlap", "c", true, () => background);
  assert.equal(guardianBypassed("overlap", "c"), true);
  try {
    await withGuardianBypass("overlap", "c", false, async () => {
      assert.equal(guardianBypassed("overlap", "c"), false);
      finishBackground();
      await automation;
      assert.equal(guardianBypassed("overlap", "c"), false);
    });
  } finally { finishBackground(); await automation; }
  assert.equal(guardianBypassed("overlap", "c"), false);
});

test('trusted commands and in-project file operations skip the model, outside operations and protected branch deletion do not', async (t) => {
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, model: 'laya-remote', layaUrl: 'http://127.0.0.1:1' });
  t.after(() => updateGuardianSettings(DEFAULT_GUARDIAN_SETTINGS));
  const identity: GuardianIdentity = { projectId: 'command-policy', conversationId: 'c', harness: 'pi', cwd: '/workspace', canReplaceTool: true };
  for (const command of [
    'git push origin main', 'gh pr edit 456 --body verified', 'node "$JOINT_BOB_WORKTREE_CLI" list',
    'rm -rf dist', 'mv src/old.ts src/new.ts', 'cp a.txt b.txt', 'mkdir -p src/new && touch src/new/index.ts',
  ]) {
    assert.deepEqual(await checkGuardian(identity, { kind: 'tool', tool: 'bash', category: 'commands', input: { command } }), { action: 'continue' }, command);
  }
  const outside = await checkGuardian(identity, { kind: 'tool', tool: 'bash', category: 'commands', input: { command: 'rm -rf /srv/outside' } });
  assert.equal(outside.action, 'block', 'outside-folder delete still requires model check (fails closed when unreachable)');
  const verdict = await checkGuardian(identity, { kind: 'tool', tool: 'bash', category: 'commands', input: { command: 'git push origin --delete main' } });
  assert.equal(verdict.action, 'block');
  assert.match((verdict as { reason: string }).reason, /protected branch/);
});

test("a check that cannot reach its model blocks the action", async () => {
  clearGuardianModelCache();
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, model: "laya-remote", layaUrl: "http://127.0.0.1:9" });
  try {
    const verdict = await checkGuardian({ projectId: "guardian-test", conversationId: "c", harness: "pi", cwd: process.cwd(), canReplaceTool: true },
      { kind: "tool", tool: "bash", category: "commands", input: { command: "make release" } });
    assert.equal(verdict.action, "block");
    assert.match((verdict as { reason: string }).reason, /Guardian could not check this command, so it was blocked/);
  } finally {
    updateGuardianSettings(DEFAULT_GUARDIAN_SETTINGS);
  }
});

test("with Guardian off and no relay rules nothing is asked", async () => {
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: false, model: "laya-remote", layaUrl: "http://127.0.0.1:9" });
  assert.deepEqual(await checkGuardian({ projectId: "p", conversationId: "c", harness: "pi", cwd: process.cwd(), canReplaceTool: true },
    { kind: "tool", tool: "bash", category: "commands", input: { command: "rm -rf /" } }), { action: "continue" });
});

test("the Laya classifier routes by difficulty through the saved Laya server, without a key", async (t) => {
  const { layaClassifier } = await import("../src/classifiers/laya.js");
  const bodies: Array<{ state: string; model: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      bodies.push(JSON.parse(body));
      response.end(JSON.stringify({ answers: { complexity: { type: "choice", choice: "level_3", confidence: 0.8 } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, layaUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  t.after(() => updateGuardianSettings(DEFAULT_GUARDIAN_SETTINGS));
  const classification = await layaClassifier.classify(`${"x".repeat(5_000)}fix the typo`, "", { options: [{ level: 3, description: "small edits" }] });
  assert.deepEqual(classification, { level: 3, score: 3, confidence: 0.8 });
  assert.equal(bodies[0].model, "multilingual");
  assert.ok(bodies[0].state.endsWith("fix the typo") && bodies[0].state.length === 3_500, "the newest part of the prompt is what Laya reads");
  assert.equal(layaClassifier.keyOptional, true);
});
