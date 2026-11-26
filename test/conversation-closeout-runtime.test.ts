import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { beginConversationCloseout, finishConversationCloseout, type CloseoutRuntime } from "../src/server/conversation-closeout.js";
import { sessionDoneOverrides, sessionFeedbackOverrides, setSessionDone, setSessionFeedback } from "../src/names.js";
import { generalShelf } from "../src/general-knowledge.js";
import { addRule, forgetRule, listProposals, projectShelf, readSubjects, readSubjectsIn } from "../src/project-knowledge.js";
import type { ProjectRecord } from "../src/types.js";

const lesson = { scope: "project" as const, subject: "tests", text: "Run the focused tests before committing.", evidence: "Skipped a failing test" };
const runtime = (): CloseoutRuntime => ({
  load: async () => ({ lastHarness: "pi", messages: [{ id: "m1", role: "user", text: "Fix this", timestamp: "2020-01-01T00:00:00Z" }] }),
  models: () => ({ classify: async () => "bad", describe: async () => ({ description: "Tests were skipped.", rules: [lesson] }), select: async () => [0] }),
  sourceRoot: async () => null,
});
const ruleTexts = (root: string) => readSubjects(root).flatMap((subject) => subject.rules.map((rule) => rule.text));

async function fixture(run: (project: ProjectRecord, id: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "closeout-runtime-"));
  const project = { id: randomUUID(), path: root } as ProjectRecord;
  const id = randomUUID();
  try { await run(project, id); }
  finally { await setSessionFeedback(id, null); await setSessionDone(id, false); await rm(root, { recursive: true, force: true }); }
}

test("automatic closeout marks Done, persists inferred feedback, and installs the rule without a person", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, null);
    assert.ok((await sessionDoneOverrides())[id]);
    assert.equal(record.status, "pending");
    assert.equal(await finishConversationCloseout(project, id, record, runtime()), undefined);
    const saved = (await sessionFeedbackOverrides())[id];
    assert.equal(saved.source, "automatic");
    assert.equal(saved.status, "complete");
    assert.deepEqual(saved.feedback, { rating: "bad", description: "Tests were skipped." });
    assert.deepEqual(ruleTexts(project.path), [lesson.text]);
    assert.match(readSubjects(project.path)[0].rules[0].evidence, new RegExp(`conversation ${id}`), "the evidence names its conversation for review");
    assert.deepEqual(listProposals(project.path), [], "nothing waits for a person");
  });
});

test("a conversation marked not important is still reviewed and rated good or bad", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, { rating: "unimportant", description: "" });
    assert.equal(record.status, "pending");
    assert.equal(await finishConversationCloseout(project, id, record, runtime()), undefined);
    const saved = (await sessionFeedbackOverrides())[id];
    assert.equal(saved.status, "complete");
    assert.deepEqual(saved.feedback, { rating: "bad", description: "Tests were skipped." });
    assert.ok((await sessionDoneOverrides())[id]);
    assert.deepEqual(ruleTexts(project.path), [lesson.text]);
  });
});

test("a general lesson is written to Joint Bob's source; a project lesson stays with the project", async () => {
  await fixture(async (project, id) => {
    const source = path.join(project.path, "joint-bob-source");
    const general = { ...lesson, scope: "general" as const, subject: "verification", text: "Run the check before saying it passed." };
    const boundary = runtime();
    boundary.sourceRoot = async () => source;
    boundary.models = () => ({ classify: async () => "good", describe: async () => ({ description: "Fine", rules: [lesson, general] }), select: async () => [0, 1] });
    const record = await beginConversationCloseout(project, "pi", id, { rating: "good", description: "" });
    await finishConversationCloseout(project, id, record, boundary);
    assert.deepEqual(ruleTexts(project.path), [lesson.text]);
    const shelf = generalShelf(source);
    assert.deepEqual(readSubjectsIn(shelf.directory).flatMap((subject) => subject.rules.map((rule) => rule.text)), [general.text]);
    assert.match(await readFile(path.join(shelf.directory, "INDEX.md"), "utf8"), /# Joint Bob general knowledge[\s\S]*\[verification\]\(verification\.md\)/);
  });
});

test("without Joint Bob's source on the machine a general lesson stays with the project, and says so", async () => {
  await fixture(async (project, id) => {
    const boundary = runtime();
    boundary.models = () => ({ classify: async () => "good", describe: async () => ({ description: "Fine", rules: [{ ...lesson, scope: "general" }] }), select: async () => [0] });
    const record = await beginConversationCloseout(project, "pi", id, { rating: "good", description: "" });
    await finishConversationCloseout(project, id, record, boundary);
    assert.match(readSubjects(project.path)[0].rules[0].evidence, /general lesson, kept here because this machine has no Joint Bob source/);
  });
});

test("a failed review remains Done with a visible error and can resume after interruption", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, { rating: "bad", description: "" });
    const failed = runtime();
    failed.models = () => ({ ...runtime().models(project, id, { messages: [], lastHarness: "pi" }), select: async () => { throw new Error("Decision model offline"); } });
    assert.equal(await finishConversationCloseout(project, id, record, failed), "Decision model offline");
    const saved = (await sessionFeedbackOverrides())[id];
    assert.equal(saved.status, "error");
    assert.equal(saved.error, "Decision model offline");
    assert.ok((await sessionDoneOverrides())[id]);
    assert.deepEqual(ruleTexts(project.path), []);
    await finishConversationCloseout(project, id, saved, runtime());
    assert.equal((await sessionFeedbackOverrides())[id].status, "complete");
    assert.equal((await sessionFeedbackOverrides())[id].error, undefined);
    assert.deepEqual(ruleTexts(project.path), [lesson.text]);
  });
});

test("a manual unimportant rating arriving during automatic inference wins", async () => {
  await fixture(async (project, id) => {
    const automatic = await beginConversationCloseout(project, "pi", id, null);
    const boundary = runtime();
    boundary.models = () => ({
      classify: async () => "bad",
      describe: async () => {
        await beginConversationCloseout(project, "pi", id, { rating: "unimportant", description: "" });
        return { description: "Old inference", rules: [lesson] };
      }, select: async () => [0],
    });
    await finishConversationCloseout(project, id, automatic, boundary);
    assert.equal((await sessionFeedbackOverrides())[id].feedback?.rating, "unimportant");
    assert.deepEqual(ruleTexts(project.path), [], "the older inference is dropped; the new rating gets its own review");
  });
});

test("reopening while feedback is inferred invalidates that work", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, { rating: "good", description: "" });
    const boundary = runtime();
    boundary.models = () => ({
      classify: async () => "good",
      describe: async () => {
        await setSessionFeedback(id, null);
        await setSessionDone(id, false);
        return { description: "Old inference", rules: [lesson] };
      }, select: async () => [0],
    });
    await finishConversationCloseout(project, id, record, boundary);
    assert.equal((await sessionDoneOverrides())[id], undefined);
    assert.equal((await sessionFeedbackOverrides())[id], undefined);
    assert.deepEqual(ruleTexts(project.path), []);
  });
});

test("new interaction during automatic classification reopens instead of applying lessons", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, null);
    const boundary = runtime();
    let loads = 0;
    boundary.load = async () => ({ lastHarness: "pi", messages: [{ id: "m1", role: "user", text: "Hi", timestamp: loads++ ? new Date().toISOString() : "2020-01-01T00:00:00Z" }] });
    await finishConversationCloseout(project, id, record, boundary);
    assert.equal((await sessionDoneOverrides())[id], undefined);
    assert.deepEqual(ruleTexts(project.path), []);
  });
});

test("a rule already known is not installed twice", async () => {
  await fixture(async (project, id) => {
    addRule(project.path, lesson);
    const record = await beginConversationCloseout(project, "pi", id, { rating: "bad", description: "" });
    await finishConversationCloseout(project, id, record, runtime());
    assert.deepEqual(ruleTexts(project.path), [lesson.text]);
    const next = await beginConversationCloseout(project, "pi", id, { rating: "good", description: "" });
    const boundary = runtime();
    boundary.models = () => ({ classify: async () => "good", describe: async () => ({ description: "Done", rules: [{ ...lesson, text: "run the focused tests before committing" }] }), select: async () => [0] });
    await finishConversationCloseout(project, id, next, boundary);
    assert.deepEqual(ruleTexts(project.path), [lesson.text], "wording that normalizes to the same rule is not added");
  });
});

test("a rule a person removed is not learned again", async () => {
  await fixture(async (project, id) => {
    const installed = addRule(project.path, lesson);
    assert.equal(forgetRule(projectShelf(project.path), lesson.subject, installed.id), true);
    const record = await beginConversationCloseout(project, "pi", id, { rating: "bad", description: "" });
    await finishConversationCloseout(project, id, record, runtime());
    assert.deepEqual(ruleTexts(project.path), []);
  });
});

test("reviews run one at a time, so closing many conversations queues them", async () => {
  await fixture(async (project, first) => {
    const second = randomUUID();
    let active = 0;
    let most = 0;
    const boundary = runtime();
    boundary.models = () => ({
      classify: async () => "good",
      describe: async () => { active += 1; most = Math.max(most, active); await new Promise((resolve) => setTimeout(resolve, 20)); active -= 1; return { description: "Fine", rules: [] }; },
      select: async () => [],
    });
    try {
      const records = [await beginConversationCloseout(project, "pi", first, null), await beginConversationCloseout(project, "pi", second, null)];
      boundary.load = async () => ({ lastHarness: "pi", messages: [{ id: "m1", role: "user", text: "Hi", timestamp: "2020-01-01T00:00:00Z" }] });
      await Promise.all([finishConversationCloseout(project, first, records[0], boundary), finishConversationCloseout(project, second, records[1], boundary)]);
      assert.equal(most, 1);
      assert.equal((await sessionFeedbackOverrides())[second].status, "complete");
    } finally { await setSessionFeedback(second, null); await setSessionDone(second, false); }
  });
});

test("a review that finished while another copy of it waited is not run again", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, { rating: "good", description: "" });
    let reviews = 0;
    const boundary = runtime();
    boundary.models = () => ({ classify: async () => "good", describe: async () => { reviews += 1; return { description: "Fine", rules: [] }; }, select: async () => [] });
    await Promise.all([finishConversationCloseout(project, id, record, boundary), finishConversationCloseout(project, id, record, boundary)]);
    assert.equal(reviews, 1);
  });
});

// Each hourly sweep retried every failed closeout (about 500 on the homeserver), rewriting and
// replicating the same error and logging it every time.
test("a closeout that fails the same way again is not rewritten or logged again", async () => {
  await fixture(async (project, id) => {
    const record = await beginConversationCloseout(project, "pi", id, { rating: "bad", description: "" });
    const failed = runtime();
    failed.models = () => ({ ...runtime().models(project, id, { messages: [], lastHarness: "pi" }), select: async () => { throw new Error("Decision model offline"); } });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      assert.equal(await finishConversationCloseout(project, id, record, failed), "Decision model offline");
      const stored = (await sessionFeedbackOverrides())[id];
      assert.equal(await finishConversationCloseout(project, id, stored, failed), "Decision model offline");
      assert.deepEqual((await sessionFeedbackOverrides())[id], stored, "the stored error is left as it was");
      assert.equal(warnings.filter((line) => line.includes(id)).length, 1, "logged once");
    } finally { console.warn = warn; }
  });
});
