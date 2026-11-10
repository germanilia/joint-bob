import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { after, before, beforeEach, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { agentResourcePaths } from "../src/agent-resources.js";
import { getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { ensureMembershipSchema } from "../src/cluster-membership.js";
import { addSharingMember, createSharingCluster } from "../src/cluster-sharing-policy.js";
import { onPeerReturned, peerAway, resetPeerAvailability } from "../src/peer-presence.js";
import { peerFetch } from "../src/relay/transport.js";
import { buildSkillBundle } from "../src/skill-sharing.js";
import { countingFileCalls } from "./file-call-counter.js";

/*
 * This node as a receiver, against a stand-in for an owner. The stand-in answers the skills
 * routes, holds an answer back until the test lets it go, or drops the connection so that the
 * request gets no answer.
 */
type Mode = "answer" | "drop" | "hold";
const ownerId = randomUUID(), clusterId = randomUUID();
const owner = { manifest: "answer" as Mode, seen: [] as string[], held: [] as Array<() => void>, skills: [] as Array<{ name: string; digest: string }>, bundles: new Map<string, { digest: string; bundle: unknown }>() };
let server: http.Server, origin: string, db: DatabaseSync;
let refreshSharedSkills: (force?: boolean) => Promise<void>;
let refreshSkillsFrom: (owner: string) => Promise<void>;
let internals: { ownerChanged: (owner: string) => Promise<unknown>; forgetOwnerPaces: () => void; ownerSettled: (owner: string) => Promise<void> };
const returns: Array<Promise<void>> = [];
let stopListening = (): void => {};

const asked = (route = "manifest"): number => owner.seen.filter((seen) => seen === route).length;
const lastError = (): string | null => (db.prepare("SELECT last_error AS error FROM skill_peer_status WHERE owner_node_id=?").get(ownerId) as { error: string | null } | undefined)?.error ?? null;
async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done(); waited += 5) { assert.ok(waited < 5_000, "timed out waiting"); await sleep(5); }
}
function frozenClock(t: TestContext): { at: (ms: number) => void } {
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  return { at: (ms) => t.mock.timers.setTime(start + ms) };
}

before(async () => {
  server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const route = (request.url ?? "").split("/").at(-1) ?? "";
      owner.seen.push(route);
      const json = (value: unknown): void => { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value)); };
      const answer = (): void => {
        if (route === "manifest") json({ ownerNodeId: ownerId, skills: owner.skills });
        else if (route === "scoped-manifest") json({ ownerNodeId: ownerId, skills: [] });
        else if (route === "bundle") { const { name } = JSON.parse(body) as { name: string }; json({ name, ...owner.bundles.get(name) }); }
        else json({ ok: true });
      };
      // A build that asks without end would hang here. Twenty requests are far more than any test expects, so it fails instead.
      const mode = route !== "manifest" || asked() > 20 ? "answer" : owner.manifest;
      if (mode === "drop") request.socket.destroy();
      else if (mode === "hold") owner.held.push(answer);
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { clusterV2Database } = await import("../src/cluster-v2-store.js");
  const { getClusterNode } = await import("../src/cluster.js");
  const sharing = await import("../src/server/skill-sharing.js");
  ({ refreshSharedSkills, refreshSkillsFrom } = sharing);
  internals = sharing.skillSharingForTests;
  db = await clusterV2Database();
  const local = (await getClusterNode()).id;
  getOrCreateClusterIdentity(db, local);
  ensureMembershipSchema(db);
  createSharingCluster(db, { id: clusterId, name: "Shared" }, local);
  addSharingMember(db, clusterId, local, ownerId, 1);
  db.prepare("INSERT INTO cluster_v2_membership_nodes VALUES(?,?,?,?,?,NULL)").run(clusterId, ownerId, "Owner", origin, "owner-key");
  // What server/peer-return.ts does when a peer that was away answers again.
  stopListening = onPeerReturned((peerId) => { returns.push(refreshSkillsFrom(peerId)); });
});
after(async () => {
  stopListening();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  // A test that failed half way may have left an answer held back.
  for (const answer of owner.held.splice(0)) answer();
  await internals.ownerSettled(ownerId);
  internals.forgetOwnerPaces();
  resetPeerAvailability();
  Object.assign(owner, { manifest: "answer", seen: [], held: [], skills: [] });
  owner.bundles.clear();
  returns.length = 0;
});

test("notices and returns that arrive during a sync lead to one more sync, not one each", async () => {
  owner.manifest = "hold";
  await internals.ownerChanged(ownerId);
  await until(() => owner.held.length === 1);
  for (let notice = 0; notice < 3; notice++) await internals.ownerChanged(ownerId);
  const returned = [refreshSkillsFrom(ownerId), refreshSkillsFrom(ownerId)];
  await sleep(50);
  assert.equal(asked(), 1, "one sync with an owner at a time");
  owner.manifest = "answer";
  for (const answer of owner.held.splice(0)) answer();
  await Promise.all(returned);
  await internals.ownerSettled(ownerId);
  assert.equal(asked(), 2, "what the running sync may have missed is fetched once more");
  await internals.ownerChanged(ownerId);
  await internals.ownerSettled(ownerId);
  assert.equal(asked(), 3, "and a later notice is fetched at once");
});

test("a person's refresh during a running sync gets a sync that started after it", async () => {
  owner.manifest = "hold";
  await internals.ownerChanged(ownerId);
  await until(() => owner.held.length === 1);
  let refreshed = false;
  const refresh = refreshSharedSkills(true).then(() => { refreshed = true; });
  await sleep(50);
  assert.deepEqual([asked(), refreshed], [1, false], "the running sync may have read the owner's list before the refresh was asked for");
  owner.manifest = "answer";
  for (const answer of owner.held.splice(0)) answer();
  await refresh;
  assert.equal(asked(), 2);
  assert.equal(lastError(), null);
});

test("a request that got no answer is repeated by the maintenance pass after ten minutes, not before", async (t) => {
  const clock = frozenClock(t);
  owner.manifest = "drop";
  await refreshSharedSkills();
  assert.equal(asked(), 1, "the pass asks an owner it has not asked yet");
  assert.match(lastError() ?? "", /fetch failed/);
  clock.at(9 * 60_000 + 59_000);
  await refreshSharedSkills();
  assert.equal(asked(), 1);
  clock.at(10 * 60_000);
  await refreshSharedSkills();
  assert.equal(asked(), 2);
});

test("an owner that was away is asked as soon as it answers again", async () => {
  owner.manifest = "drop";
  await refreshSharedSkills();
  assert.equal(asked(), 1);
  assert.equal(peerAway(ownerId), true, "the unanswered request marked the owner away");
  owner.manifest = "answer";
  // Any answer from it is its return, as server/peer-return.ts hears it.
  await (await peerFetch(new URL("/ping", origin), {}, ownerId)).text();
  await Promise.all(returns.splice(0));
  assert.equal(asked(), 2, "its return fetches what it shares at once");
  assert.equal(lastError(), null);
});

test("a received skill that did not change is not read again on later syncs", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "skill-pacing-"));
  const name = "received-skill", skillsRoot = agentResourcePaths().sharedSkills, destination = path.join(skillsRoot, name);
  t.after(async () => { await rm(source, { recursive: true, force: true }); await rm(destination, { recursive: true, force: true }); });
  await mkdir(path.join(source, name, "docs"), { recursive: true });
  await writeFile(path.join(source, name, "SKILL.md"), `---\nname: ${name}\ndescription: Shared by the stand-in owner\n---\nBody\n`);
  await writeFile(path.join(source, name, "docs", "guide.md"), "guide");
  const built = await buildSkillBundle(path.join(source, name), name);
  owner.skills = [{ name, digest: built.digest }];
  owner.bundles.set(name, built);

  await refreshSharedSkills(true);
  assert.equal(asked("bundle"), 1);
  assert.equal((await buildSkillBundle(destination, name)).digest, built.digest);
  // A digest is kept only for files nothing touched in the last two seconds; the clock moves instead of the test waiting.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60_000 });
  const second = await countingFileCalls(skillsRoot, () => refreshSharedSkills(true));
  assert.ok(second.read.length > 0, "the first check after the install reads the copy");
  for (let sync = 0; sync < 2; sync++) {
    const later = await countingFileCalls(skillsRoot, () => refreshSharedSkills(true));
    assert.deepEqual(later.read, [], "an unchanged copy is checked by its look alone");
  }
  assert.equal(asked("bundle"), 1, "and never downloaded again");
  assert.equal(asked(), 4);

  await sleep(30);
  await writeFile(path.join(destination, "docs", "guide.md"), "GUIDE");
  await refreshSharedSkills(true);
  assert.match(lastError() ?? "", /Modified received skill preserved: received-skill/, "an edit of the copy is still noticed on the next sync");
});
