import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BrowserStore } from "../src/browser-store.js";
import { createSharingCluster, ensureClusterSharingPolicySchema, removeSharingMember } from "../src/cluster-sharing-policy.js";
import { getClusterNode } from "../src/cluster.js";
import { resolveDataDirectory } from "../src/data-directory.js";

/* The browser store asks whether the sharing and node tables exist on every grant check. A table
   that was found is not looked for again; a missing one is, until another connection makes it. */

test("the browser store looks for the membership table until it is there, and not again", async (t) => {
  const local = (await getClusterNode()).id;
  const store = new BrowserStore();
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  t.after(() => { db.close(); store.close(); });
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sharing_memberships'").get(), undefined, "this test needs a node that has no sharing tables yet");
  const projectId = randomUUID(), cluster = randomUUID();
  const profile = store.createProfile(randomUUID(), "Fixture");
  const access = { nodeId: local, projectId, conversationId: "conversation" };
  store.grantProfileAccess(profile.id, { scope: "cluster", clusterId: cluster });
  assert.equal(store.profileUsable(profile.id, access), false, "no sharing tables: a cluster grant reaches nobody");
  assert.equal(store.profileUsable(profile.id, access), false);
  const prepare = DatabaseSync.prototype.prepare;
  let lookedFor = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) { if (sql.includes("sqlite_master")) lookedFor++; return prepare.call(this, sql); });
  for (let i = 0; i < 10; i++) assert.equal(store.profileUsable(profile.id, access), false);
  assert.equal(lookedFor, 10, "a missing table is looked for on every check");

  // Another connection brings the sharing tables, and this machine joins the cluster.
  ensureClusterSharingPolicySchema(db);
  createSharingCluster(db, { id: cluster, name: "Browser" }, local);
  assert.equal(store.profileUsable(profile.id, access), true, "found on the next check");
  assert.equal(store.profileUsable(profile.id, access), true);
  lookedFor = 0;
  for (let i = 0; i < 20; i++) assert.equal(store.profileUsable(profile.id, access), true);
  assert.equal(lookedFor, 0, "the membership and node tables were found and are not looked for again");
  removeSharingMember(db, cluster, local, local);
  assert.equal(store.profileUsable(profile.id, access), false, "the membership rows are still read on every check");
});
