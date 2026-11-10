import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { before, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { agentResourcePaths } from "../src/agent-resources.js";
import { addSharingMember, createSharingCluster } from "../src/cluster-sharing-policy.js";
import { buildSkillBundle, setSkillShares } from "../src/skill-sharing.js";
import { withSkillMutation } from "../src/skill-sharing-files.js";
import { countingFileCalls } from "./file-call-counter.js";

// What POST /api/cluster/v2/skills/manifest answers, asked the way the route asks it.
type Manifest = { ownerNodeId: string; skills: Array<{ name: string; digest: string }> };
let manifestFor: (receiver: string) => Promise<Manifest>;
let scopedManifestFor: (receiver: string) => Promise<{ skills: unknown[] }>;
let db: DatabaseSync, local: string;
const skillsRoot = agentResourcePaths().sharedSkills;
// Two peers in two clusters: alpha goes to both, beta to the first, gamma to the second, hidden to nobody.
const first = randomUUID(), second = randomUUID(), clusterOne = randomUUID(), clusterTwo = randomUUID();

async function writeSkill(name: string, files: Record<string, string> = {}): Promise<void> {
  const directory = path.join(skillsRoot, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}\n---\nBody of ${name}\n`);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
  }
}
const fresh = async (name: string): Promise<string> => (await buildSkillBundle(path.join(skillsRoot, name), name)).digest;
const offered = (manifest: Manifest): Record<string, string> => Object.fromEntries(manifest.skills.map((skill) => [skill.name, skill.digest]));
/** A digest is kept only for a folder nothing touched in the last two seconds, so the clock moves ahead instead of the test waiting. */
const aMinuteLater = (t: TestContext): void => t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60_000 });
/** Longer than a tick of any file system clock: two writes this far apart never carry the same time. */
const nextTick = (): Promise<void> => sleep(30);
const walks = (calls: { listed: string[] }): number => calls.listed.filter((directory) => directory === "").length;

before(async () => {
  const { clusterV2Database } = await import("../src/cluster-v2-store.js");
  const { getClusterNode } = await import("../src/cluster.js");
  ({ manifestFor, scopedManifestFor } = (await import("../src/server/skill-sharing.js")).skillSharingForTests);
  db = await clusterV2Database();
  local = (await getClusterNode()).id;
  createSharingCluster(db, { id: clusterOne, name: "One" }, local);
  addSharingMember(db, clusterOne, local, first, 1);
  createSharingCluster(db, { id: clusterTwo, name: "Two" }, local);
  addSharingMember(db, clusterTwo, local, second, 1);
  await writeSkill("alpha", { "scripts/run.sh": "#!/bin/sh\necho alpha\n", "notes.txt": "aaaa" });
  await writeSkill("beta", { "docs/guide.md": "guide" });
  await writeSkill("gamma");
  await writeSkill("hidden", { "private.txt": "kept here" });
  setSkillShares(db, local, "alpha", [clusterOne, clusterTwo]);
  setSkillShares(db, local, "beta", [clusterOne]);
  setSkillShares(db, local, "gamma", [clusterTwo]);
});

test("a manifest for unchanged skills reads no file, and a skill granted to nobody is never read", async (t) => {
  aMinuteLater(t);
  const cold = await countingFileCalls(skillsRoot, () => manifestFor(first));
  assert.equal(cold.result.ownerNodeId, local);
  assert.deepEqual(offered(cold.result), { alpha: await fresh("alpha"), beta: await fresh("beta") });
  assert.ok(cold.read.length > 0);
  assert.ok(!cold.read.some((file) => file.startsWith("hidden")), "hidden is shared with nobody");
  for (const receiver of [first, second, first]) {
    const warm = await countingFileCalls(skillsRoot, () => manifestFor(receiver));
    assert.deepEqual(warm.read, [], "nothing changed, so no file content is read");
    assert.equal(walks(warm), 1);
  }
  assert.deepEqual(offered(await manifestFor(second)), { alpha: await fresh("alpha"), gamma: await fresh("gamma") });
});

test("a file edited, added or removed on disk shows in the very next manifest", async (t) => {
  aMinuteLater(t);
  const file = (name: string): string => path.join(skillsRoot, "alpha", name);
  let digest = offered(await manifestFor(first)).alpha;
  for (const [what, change] of [
    ["edited in place, same size", () => writeFile(file("notes.txt"), "bbbb")],
    ["added", () => writeFile(file("more.txt"), "more")],
    ["removed", () => rm(file("more.txt"))],
    ["edited in a folder", () => writeFile(file("scripts/run.sh"), "#!/bin/sh\necho changed\n")],
  ] as Array<[string, () => Promise<void>]>) {
    await nextTick();
    await change();
    const next = await countingFileCalls(skillsRoot, () => manifestFor(first));
    assert.equal(offered(next.result).alpha, await fresh("alpha"), what);
    assert.notEqual(offered(next.result).alpha, digest, what);
    assert.ok(next.read.every((read) => read.startsWith("alpha")), `${what}: only the changed skill is read again`);
    digest = offered(next.result).alpha;
    assert.equal(offered(await manifestFor(second)).alpha, digest, `${what}: every receiver sees it`);
  }
});

test("a change of sharing shows in the next manifest without a file being read", async (t) => {
  aMinuteLater(t);
  t.after(() => { setSkillShares(db, local, "beta", [clusterOne]); setSkillShares(db, local, "hidden", []); });
  await manifestFor(first);
  setSkillShares(db, local, "beta", []);
  const unshared = await countingFileCalls(skillsRoot, () => manifestFor(first));
  assert.deepEqual(Object.keys(offered(unshared.result)), ["alpha"]);
  assert.deepEqual(unshared.read, []);
  setSkillShares(db, local, "beta", [clusterOne]);
  setSkillShares(db, local, "hidden", [clusterOne]);
  const shared = await countingFileCalls(skillsRoot, () => manifestFor(first));
  assert.deepEqual(offered(shared.result), { alpha: await fresh("alpha"), beta: await fresh("beta"), hidden: await fresh("hidden") });
  assert.ok(shared.read.length > 0 && shared.read.every((read) => read.startsWith("hidden")), "only the newly shared skill is read");
});

test("requests that arrive together share one walk of the skills folder", async (t) => {
  aMinuteLater(t);
  const together = await countingFileCalls(skillsRoot, () => Promise.all([manifestFor(first), manifestFor(second), manifestFor(first), scopedManifestFor(first), manifestFor(second), manifestFor(first)]));
  assert.equal(walks(together), 1, "six requests, one walk");
  const [one, two, , scoped] = together.result;
  assert.deepEqual(Object.keys(offered(one)), ["alpha", "beta"]);
  assert.deepEqual(Object.keys(offered(two)), ["alpha", "gamma"]);
  assert.deepEqual(scoped.skills, []);
});

test("a manifest waits for a running skill change and then lists what it left, in one walk", async (t) => {
  aMinuteLater(t);
  const away = path.join(path.dirname(skillsRoot), `alpha-away-${randomUUID()}`);
  let finish!: () => void;
  const paused = new Promise<void>((resolve) => { finish = resolve; });
  // As an install does: the old copy is moved away, and the new one arrives a moment later.
  const change = withSkillMutation(async () => {
    await rename(path.join(skillsRoot, "alpha"), away);
    await paused;
    await writeFile(path.join(away, "notes.txt"), "installed");
    await rename(away, path.join(skillsRoot, "alpha"));
  });
  let answered = 0;
  const calls = countingFileCalls(skillsRoot, () => Promise.all([first, second, first].map((receiver) => manifestFor(receiver).then((manifest) => { answered++; return manifest; }))));
  await sleep(100);
  const answeredMeanwhile = answered;
  finish();
  await change;
  const done = await calls;
  assert.equal(answeredMeanwhile, 0, "no manifest is answered while a skill is moved away");
  assert.equal(walks(done), 1, "the three that waited share one walk");
  for (const manifest of done.result) assert.equal(offered(manifest).alpha, await fresh("alpha"), "alpha is listed, as the change left it");
});

test("a skill that cannot be bundled fails only the receivers it is shared with", async (t) => {
  aMinuteLater(t);
  await symlink(path.join(skillsRoot, "gamma", "SKILL.md"), path.join(skillsRoot, "gamma", "link.md"));
  try {
    const [one, two] = await Promise.allSettled([manifestFor(first), manifestFor(second)]);
    assert.equal(one.status, "fulfilled");
    assert.deepEqual(Object.keys(offered((one as PromiseFulfilledResult<Manifest>).value)), ["alpha", "beta"]);
    assert.equal(two.status, "rejected");
    assert.match(String((two as PromiseRejectedResult).reason?.message), /symbolic links/);
    await assert.rejects(manifestFor(second), /symbolic links/, "and again on the next request");
  } finally { await rm(path.join(skillsRoot, "gamma", "link.md"), { force: true }); }
  assert.deepEqual(offered(await manifestFor(second)), { alpha: await fresh("alpha"), gamma: await fresh("gamma") });
});

test("a node outside every shared cluster gets no manifest", async () => {
  await assert.rejects(manifestFor(randomUUID()), { status: 403 });
});
