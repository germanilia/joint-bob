// A machine that is finishing turns an earlier update interrupted refuses to update. That refusal
// used to count as a failed update, and a failed update keeps the automatic updater away for six
// hours: on 2026-11-10 a machine whose turn ended after forty minutes would have waited until morning.
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveDataDirectory } from "../src/data-directory.js";
import { completeUpdateRecovery, saveUpdateRecoveries } from "../src/update-recovery.js";
import { scheduledUpdateStep, setAutoUpdate, startUpdateScheduler } from "../src/updater.js";

const HOUR = 60 * 60_000;
const busy = "This machine is still finishing 1 conversation turn that an earlier update interrupted. It can update once that turn ends; stop it to update now.";
const at = (msAgo: number, now: number) => new Date(now - msAgo).toISOString();

test("a refusal because turns are still being finished is a wait, not a failure", () => {
  const now = Date.parse("2026-11-10T23:30:00.000Z");
  const failed = (error: string, msAgo: number) => ({ state: "failed" as const, error, updatedAt: at(msAgo, now) });
  assert.equal(scheduledUpdateStep({ last: null, now, newer: true, turnsRecovering: 0 }), "install");
  assert.equal(scheduledUpdateStep({ last: null, now, newer: true, turnsRecovering: 2 }), "wait", "no job is started while turns are being finished");
  assert.equal(scheduledUpdateStep({ last: null, now, newer: false, turnsRecovering: 0 }), "nothing");
  assert.equal(scheduledUpdateStep({ last: failed("Updater helper exited with 1", HOUR), now, newer: true, turnsRecovering: 0 }), "backoff", "a real failure still keeps the updater away");
  assert.equal(scheduledUpdateStep({ last: failed("Updater helper exited with 1", 7 * HOUR), now, newer: true, turnsRecovering: 0 }), "install", "for six hours, not for good");
  assert.equal(scheduledUpdateStep({ last: failed(busy, 60_000), now, newer: true, turnsRecovering: 0 }), "install", "the turn ended: the machine updates at the next look");
  assert.equal(scheduledUpdateStep({ last: failed(busy.replace("1 conversation turn", "3 conversation turns"), 60_000), now, newer: true, turnsRecovering: 1 }), "wait");
  assert.equal(scheduledUpdateStep({ last: { state: "succeeded", error: null, updatedAt: at(60_000, now) }, now, newer: true, turnsRecovering: 0 }), "install");
});

test("with a newer release and a turn still being finished, the scheduler starts no update and looks again in three minutes", async (t) => {
  const previous = { release: process.env.JOINT_BOB_RELEASE, api: process.env.JOINT_BOB_RELEASE_API };
  process.env.JOINT_BOB_RELEASE = "b".repeat(40);
  // The public releases feed, which needs no credential.
  const api = "https://api.github.com/repos/germanilia/joint-bob-releases";
  process.env.JOINT_BOB_RELEASE_API = api;
  t.after(() => {
    for (const [name, value] of Object.entries({ JOINT_BOB_RELEASE: previous.release, JOINT_BOB_RELEASE_API: previous.api })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  setAutoUpdate(true);
  const recovery = { id: "busy-wait-recovery", kind: "chat" as const, engine: "claude" as const, projectId: "project", cwd: "/tmp", sessionId: "session", sessionPath: "claude:/tmp/session.jsonl", taskId: null, phase: null, queuedPrompts: [], model: null, effort: null, createdAt: new Date().toISOString() };
  await saveUpdateRecoveries([recovery]);
  t.after(() => completeUpdateRecovery(recovery.id));
  const release = { tag_name: "v999.0.0", name: "v999.0.0", body: "", published_at: new Date().toISOString(), assets: [
    { name: "joint-bob.tar.gz", url: `${api}/releases/assets/1`, browser_download_url: "https://example.invalid/archive" },
    { name: "joint-bob.tar.gz.sha256", url: `${api}/releases/assets/2`, browser_download_url: "https://example.invalid/checksum" },
  ] };
  const fetched = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(release), { status: 200, headers: { "Content-Type": "application/json" } }));
  let tick: () => void = () => {};
  const delays: number[] = [];
  t.mock.method(globalThis, "setTimeout", ((_callback: () => void, milliseconds: number) => { delays.push(milliseconds); return { unref() {} }; }) as never);
  t.mock.method(globalThis, "setInterval", ((callback: () => void) => { tick = callback; return { unref() {} }; }) as never);
  startUpdateScheduler();
  tick();
  for (let turn = 0; turn < 50 && !delays.includes(3 * 60_000); turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fetched.mock.callCount() >= 1, "the release feed was asked");
  assert.ok(delays.includes(3 * 60_000), `it looks again in three minutes (timers asked for: ${delays.join(", ")})`);
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"), { readOnly: true });
  try {
    assert.equal((db.prepare("SELECT count(*) n FROM update_jobs").get() as { n: number }).n, 0, "no update job is started, so nothing fails and nothing backs off");
  } finally { db.close(); }
});
