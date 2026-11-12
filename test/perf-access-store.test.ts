import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, type TestContext } from "node:test";
import { runAsAccount, type ActingAccount } from "../src/account-context.js";
import { canonicalLocalHome, localAccountIdIn } from "../src/accounts.js";
import { requireClusterMember } from "../src/assistant-teams/access.js";
import { prepareTeamProject, teamDatabase } from "../src/assistant-teams/store.js";
import { createAdministrator, localAccountIdForUsername, upsertReplicatedUser, type AuthSession } from "../src/auth.js";
import { addClusterLocalMember } from "../src/cluster-accounts.js";
import { getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { createMembershipCluster } from "../src/cluster-membership.js";
import { addSharingMember, createSharingCluster } from "../src/cluster-sharing-policy.js";
import { getResourcePolicyState, updateResourceSharing } from "../src/cluster-sharing.js";
import { getClusterNode } from "../src/cluster.js";
import { resolveDataDirectory } from "../src/data-directory.js";
import { ensureOwnershipSchema } from "../src/ownership.js";
import { addProject, getProject, listProjects, projectVisible } from "../src/store.js";
import type { ProjectRecord } from "../src/types.js";
import { openNodeDatabase } from "../src/node-database.js";

/* A project is looked up, and its visibility to the acting person checked, on nearly every
   request. What those lookups read besides the project's own row is kept until the next write.
   These tests hold them to that: an answer follows every change at once, whichever connection
   made it; only the row itself is read in between; nothing a rolled back transaction showed is
   served afterwards; and what is read from the sign-in tables is never kept at all. */

const root = mkdtempSync(path.join(os.tmpdir(), "jb-perf-access-store-"));
let second: DatabaseSync | undefined;
after(() => { second?.close(); rmSync(root, { recursive: true, force: true }); });

/** A second connection to the node's database, as another module or process would hold. */
async function other(): Promise<DatabaseSync> {
  await getClusterNode();
  second ??= openNodeDatabase(path.join(resolveDataDirectory(), "node.db"));
  return second;
}
async function project(name: string): Promise<ProjectRecord> {
  return addProject(name, path.join(root, `${name}-${randomUUID()}`), { type: "personal" });
}
function person(role: "admin" | "member" = "member", accountId = randomUUID().replaceAll("-", "")): ActingAccount {
  return { accountId, username: `person-${accountId.slice(0, 6)}`, role, isRemoteLogin: false, homeNodeId: null };
}
function owns(db: DatabaseSync, projectId: string, account: ActingAccount | undefined): void {
  ensureOwnershipSchema(db);
  db.prepare("DELETE FROM resource_account_owners WHERE kind='project' AND resource_id=?").run(projectId);
  if (account) db.prepare("INSERT INTO resource_account_owners(kind, resource_id, account_id, created_at) VALUES('project', ?, ?, 'now')").run(projectId, account.accountId);
}

/** Counts the queries code runs: every query here is prepared where it runs. */
function queries(t: TestContext): { count: () => number; reset: () => void } {
  const prepare = DatabaseSync.prototype.prepare;
  let count = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) { count++; return prepare.call(this, sql); });
  return { count: () => count, reset: () => { count = 0; } };
}

/** The connection a module keeps to itself, caught as it prepares a query. */
async function connectionOf(t: TestContext, sql: string, run: () => unknown): Promise<DatabaseSync> {
  const prepare = DatabaseSync.prototype.prepare;
  let found: DatabaseSync | undefined;
  const spy = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, text: string) { if (text.includes(sql)) found = this; return prepare.call(this, text); });
  try { await run(); } finally { spy.mock.restore(); }
  assert.ok(found, `no query with "${sql}" was prepared`);
  return found;
}

test("getProject reads only the project's row between writes and follows every change at once", async (t) => {
  const db = await other(), local = (await getClusterNode()).id;
  const made = await project("lookup");
  assert.equal((await getProject(made.id))?.name, "lookup");
  await getProject(made.id);
  const asked = queries(t);
  for (let i = 0; i < 20; i++) assert.equal((await getProject(made.id))?.id, made.id);
  assert.equal(asked.count(), 40, "two queries a call: the id and the row. Visibility, locations and clusters are kept");

  db.prepare("UPDATE projects SET name='renamed' WHERE id=?").run(made.id);
  assert.equal((await getProject(made.id))?.name, "renamed");
  db.prepare("INSERT INTO project_locations VALUES(?, 'node-x', '/somewhere/else')").run(made.id);
  assert.deepEqual((await getProject(made.id))?.locations, [{ nodeId: "node-x", path: "/somewhere/else" }], "a location added through another connection");
  db.prepare("DELETE FROM project_locations WHERE project_id=?").run(made.id);
  assert.equal((await getProject(made.id))?.locations, undefined);

  const cluster = randomUUID();
  createSharingCluster(db, { id: cluster, name: "Lookup" }, local);
  assert.deepEqual((await getProject(made.id))?.clusterIds, []);
  updateResourceSharing(db, local, "project", made.id, getResourcePolicyState(db, "project", made.id).generation, [{ clusterId: cluster, projectId: null }]);
  assert.deepEqual((await getProject(made.id))?.clusterIds, [cluster], "shared through another connection");
  updateResourceSharing(db, local, "project", made.id, getResourcePolicyState(db, "project", made.id).generation, []);
  assert.deepEqual((await getProject(made.id))?.clusterIds, []);

  db.prepare("UPDATE cluster_v2_resource_policy SET deleted=1 WHERE kind='project' AND resource_id=?").run(made.id);
  assert.equal(await getProject(made.id), undefined, "a project whose sharing record is deleted is gone");
  assert.equal((await listProjects()).some((listed) => listed.id === made.id), false);
  db.prepare("UPDATE cluster_v2_resource_policy SET deleted=0 WHERE kind='project' AND resource_id=?").run(made.id);
  assert.equal((await getProject(made.id))?.id, made.id);
  assert.equal(await getProject("no-such-project"), undefined);
});

test("the record getProject hands out is the caller's own", async () => {
  const db = await other(), local = (await getClusterNode()).id;
  const made = await project("own-copy");
  const cluster = randomUUID();
  createSharingCluster(db, { id: cluster, name: "Copy" }, local);
  updateResourceSharing(db, local, "project", made.id, getResourcePolicyState(db, "project", made.id).generation, [{ clusterId: cluster, projectId: null }]);
  db.prepare("INSERT INTO project_locations VALUES(?, 'node-x', '/x')").run(made.id);
  const first = (await getProject(made.id))!;
  first.name = "changed by the caller";
  first.locations![0].path = "/changed";
  first.locations!.push({ nodeId: "added", path: "/added" });
  first.clusterIds!.push("added");
  first.ownerNodeId = "changed";
  const again = (await getProject(made.id))!;
  assert.equal(again.name, "own-copy");
  assert.deepEqual(again.locations, [{ nodeId: "node-x", path: "/x" }]);
  assert.deepEqual(again.clusterIds, [cluster]);
  assert.equal(again.ownerNodeId, local);
  assert.equal(again.locallyOwned, true);
  const listed = (await listProjects()).find((record) => record.id === made.id)!;
  listed.clusterIds!.length = 0;
  assert.deepEqual((await listProjects()).find((record) => record.id === made.id)!.clusterIds, [cluster]);

  // Each project has its own kept parts.
  const plain = await project("plain");
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await getProject(made.id))!.locations, [{ nodeId: "node-x", path: "/x" }]);
    assert.equal((await getProject(plain.id))!.locations, undefined);
    assert.deepEqual((await getProject(plain.id))!.clusterIds, []);
    assert.deepEqual((await getProject(made.id))!.clusterIds, [cluster]);
  }
  const both = await listProjects();
  assert.deepEqual(both.find((record) => record.id === made.id)!.clusterIds, [cluster]);
  assert.deepEqual(both.find((record) => record.id === plain.id)!.clusterIds, []);
});

test("what a transaction on the store's own connection showed is not served after it is rolled back", async (t) => {
  const made = await project("rolled-back"), owner = person();
  const store = await connectionOf(t, "SELECT * FROM projects WHERE id = ?", () => getProject(made.id));
  assert.equal((await getProject(made.id))?.locations, undefined);
  // A write through the store's own connection is followed at once, like one through another.
  store.prepare("INSERT INTO project_locations VALUES(?, 'node-y', '/own')").run(made.id);
  assert.deepEqual((await getProject(made.id))?.locations, [{ nodeId: "node-y", path: "/own" }]);
  store.prepare("DELETE FROM project_locations WHERE project_id=?").run(made.id);
  assert.equal((await getProject(made.id))?.locations, undefined);
  assert.equal(await projectVisible(made.id, owner), false);
  owns(store, made.id, owner);
  assert.equal(await projectVisible(made.id, owner), true);
  owns(store, made.id, undefined);
  assert.equal(await projectVisible(made.id, owner), false);
  store.exec("BEGIN");
  try {
    owns(store, made.id, owner);
    assert.equal(await projectVisible(made.id, owner), true, "a transaction reads its own writes");
    assert.equal((await runAsAccount(owner, () => getProject(made.id)))?.id, made.id);
  } finally { store.exec("ROLLBACK"); }
  assert.equal(await projectVisible(made.id, owner), false, "the rolled back ownership is not served");
  assert.equal(await runAsAccount(owner, () => getProject(made.id)), undefined);
  store.exec("BEGIN");
  try {
    store.prepare("INSERT INTO project_locations VALUES(?, 'node-x', '/uncommitted')").run(made.id);
    assert.deepEqual((await getProject(made.id))?.locations, [{ nodeId: "node-x", path: "/uncommitted" }], "a transaction reads its own writes");
    assert.deepEqual((await listProjects()).find((record) => record.id === made.id)?.locations, [{ nodeId: "node-x", path: "/uncommitted" }]);
    store.prepare("UPDATE cluster_v2_resource_policy SET deleted=1 WHERE kind='project' AND resource_id=?").run(made.id);
    assert.equal(await getProject(made.id), undefined);
  } finally { store.exec("ROLLBACK"); }
  assert.equal((await getProject(made.id))?.id, made.id, "the rolled back deletion is not served");
  assert.equal((await getProject(made.id))?.locations, undefined, "nor the rolled back location");
  assert.equal((await listProjects()).find((record) => record.id === made.id)?.locations, undefined);

  // A table that a rolled back transaction made is not remembered as there.
  assert.equal(store.prepare("SELECT 1 FROM sqlite_master WHERE name='assistant_team_projects'").get(), undefined, "this part needs a node that has no team table yet");
  const member = person();
  store.exec("BEGIN");
  try {
    store.exec("CREATE TABLE assistant_team_projects (project_id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, executor_account_id TEXT NOT NULL)");
    assert.equal(await projectVisible(made.id, member), false);
  } finally { store.exec("ROLLBACK"); }
  assert.equal(await projectVisible(made.id, member), false, "the table is gone again, and no rows are asked of it");
});

test("who may see a project is answered per person, kept between writes, and follows ownership at once", async (t) => {
  const db = await other();
  const made = await project("owned"), member = person(), someoneElse = person();
  const as = <T>(account: ActingAccount, work: () => Promise<T>): Promise<T> => runAsAccount(account, work);
  assert.equal((await getProject(made.id))?.id, made.id, "the node itself sees every project");
  assert.equal(await as(member, () => getProject(made.id)), undefined, "the admin's project is not a member's");
  assert.equal(await as(member, () => projectVisible(made.id)), false);
  assert.equal(await projectVisible(made.id, member), false);

  owns(db, made.id, member);
  assert.equal((await as(member, () => getProject(made.id)))?.id, made.id, "made the member's through another connection");
  assert.equal(await as(member, () => projectVisible(made.id)), true);
  assert.equal(await as(someoneElse, () => projectVisible(made.id)), false, "and nobody else's");
  assert.deepEqual((await as(member, () => listProjects())).map((record) => record.id), [made.id]);
  assert.deepEqual(await as(someoneElse, () => listProjects()), []);

  await as(member, () => projectVisible(made.id));
  const asked = queries(t);
  for (let i = 0; i < 20; i++) assert.equal(await as(member, () => projectVisible(made.id)), true);
  assert.equal(asked.count(), 20, "one query a call, for the id: the person's answer is kept");
  asked.reset();
  for (let i = 0; i < 10; i++) assert.equal((await as(member, () => listProjects())).length, 1);
  assert.equal(asked.count(), 10, "a listing reads the rows and nothing else");

  owns(db, made.id, someoneElse);
  assert.equal(await as(member, () => projectVisible(made.id)), false, "handed to someone else");
  assert.equal(await as(member, () => getProject(made.id)), undefined);
  assert.deepEqual(await as(member, () => listProjects()), []);
  assert.equal(await as(someoneElse, () => projectVisible(made.id)), true);
  assert.deepEqual((await as(someoneElse, () => listProjects())).map((record) => record.id), [made.id]);
  owns(db, made.id, undefined);
  assert.equal(await as(someoneElse, () => projectVisible(made.id)), false);
});

test("one person is answered apart as admin and as member", async (t) => {
  const db = await other(), local = (await getClusterNode()).id;
  const made = await project("twins"), twin = randomUUID();
  const admin = person("admin"), sameAsMember: ActingAccount = { ...admin, role: "member" };
  // The project becomes the twin's: a copy of the admin's own project on this machine.
  db.prepare("UPDATE sharing_resource_owners SET owner_node_id=? WHERE kind='project' AND resource_id=?").run(twin, made.id);
  db.prepare("INSERT INTO cluster_v2_twin_relationships VALUES(?,?,?,'{}','signature',NULL,'active',NULL)").run(randomUUID(), local, twin);
  assert.equal(await projectVisible(made.id, admin), true, "a twin's project is the admin's");
  assert.equal(await projectVisible(made.id, sameAsMember), false, "and not a member's, whatever their id");
  assert.equal(await projectVisible(made.id, admin), true);
  // Worked out again after a write, the answer looks for no table it has found before: at most the team table, which this node may not have yet.
  db.prepare("UPDATE projects SET updated_at=? WHERE id=?").run(new Date(Date.now() + 1000).toISOString(), made.id);
  const prepare = DatabaseSync.prototype.prepare;
  let asked = 0, lookedFor = 0;
  const spy = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) { asked++; if (sql.includes("sqlite_master")) lookedFor++; return prepare.call(this, sql); });
  assert.equal(await projectVisible(made.id, admin), true);
  spy.mock.restore();
  assert.ok(asked > 1, "the write ended the kept answer, so it was worked out again");
  assert.ok(lookedFor <= 1, `the twin table was found before and is not looked for again, got ${lookedFor} lookups`);
  db.prepare("UPDATE cluster_v2_twin_relationships SET status='revoked' WHERE peer_node_id=?").run(twin);
  assert.equal(await projectVisible(made.id, admin), false, "the twin was let go");
});

test("a team project's answer is read every time: its members come from the sign-in tables", async (t) => {
  const db = await teamDatabase(), host = await getClusterNode();
  createAdministrator("perfadmin", "Synthetic-password-123!", false);
  const accountId = localAccountIdForUsername("perfadmin")!;
  const session: AuthSession = { id: randomUUID(), userId: randomUUID(), accountId, username: "perfadmin", homeNodeId: null, isRemoteLogin: false, email: null, role: "admin", csrfToken: "fixture", mustChangePassword: false };
  const cluster = randomUUID();
  createMembershipCluster(db, { nodeId: host.id, name: "host", url: "http://127.0.0.1:19001" }, { id: cluster, name: "Perf team" });
  addClusterLocalMember(db, cluster, accountId);
  const projectId = await prepareTeamProject(await requireClusterMember(session, cluster));
  const admin: ActingAccount = { accountId, username: "perfadmin", role: "admin", isRemoteLogin: false, homeNodeId: null };
  assert.equal(await projectVisible(projectId, admin), true, "a member of the team's cluster");
  assert.equal(await projectVisible(projectId, person()), false);

  // The sign-in connection may be inside a transaction of its own, which the store's connection cannot see into.
  // Here it still reads the member as enabled while another connection has already switched them off.
  const elsewhere = await other();
  const signIn = await connectionOf(t, "FROM users WHERE home_node_id IS NULL ORDER BY created_at", () => projectVisible(projectId, admin));
  signIn.exec("BEGIN");
  try {
    signIn.prepare("SELECT disabled FROM users WHERE username='perfadmin'").get();
    elsewhere.prepare("UPDATE users SET disabled=1 WHERE username='perfadmin'").run();
    assert.equal(await projectVisible(projectId, admin), true, "answered from what the sign-in connection reads now");
    assert.equal((await runAsAccount(admin, () => getProject(projectId)))?.id, projectId);
    assert.equal((await runAsAccount(admin, () => listProjects())).some((record) => record.id === projectId), true);
  } finally { signIn.exec("COMMIT"); }
  assert.equal(await projectVisible(projectId, admin), false, "its transaction ended without a write: an answer kept until the next write would still say yes");
  assert.equal(await runAsAccount(admin, () => getProject(projectId)), undefined);
  assert.equal((await runAsAccount(admin, () => listProjects())).some((record) => record.id === projectId), false);
  elsewhere.prepare("UPDATE users SET disabled=0 WHERE username='perfadmin'").run();
  assert.equal(await projectVisible(projectId, admin), true);
});

test("a visitor's answer is read every time: it rests on the sign-in tables, which another connection holds", async (t) => {
  const db = await other(), local = (await getClusterNode()).id;
  const made = await project("visited"), home = randomUUID(), cluster = randomUUID();
  // Sharing with another node signs a statement for it, so this node needs its key.
  getOrCreateClusterIdentity(db, local);
  createSharingCluster(db, { id: cluster, name: "Visited" }, local);
  addSharingMember(db, cluster, local, home, 1);
  updateResourceSharing(db, local, "project", made.id, getResourcePolicyState(db, "project", made.id).generation, [{ clusterId: cluster, projectId: null }]);
  const accountId = randomUUID().replaceAll("-", "");
  const visit = (clusterIds: string[]): void => { upsertReplicatedUser({ homeNodeId: home, username: "perfvisitor", email: null, accountId, passwordHash: Buffer.from("synthetic"), passwordSalt: Buffer.from("synthetic"), mfaRequired: false, clusterIds }); };
  const visitor: ActingAccount = { accountId, username: "perfvisitor", role: null, isRemoteLogin: true, homeNodeId: home };
  visit([cluster]);
  assert.equal(await projectVisible(made.id, visitor), true, "shared into a cluster the visitor joined at home");
  assert.equal((await runAsAccount(visitor, () => getProject(made.id)))?.id, made.id);
  visit([]);
  assert.equal(await projectVisible(made.id, visitor), false, "the home node says they left");
  visit([cluster]);
  assert.equal(await projectVisible(made.id, visitor), true);

  // The sign-in connection may be inside a transaction of its own, which the store's connection cannot see into.
  // Here it still reads the visitor's clusters as they were while another connection has already emptied them.
  const signIn = await connectionOf(t, "SELECT remote_clusters FROM users", () => projectVisible(made.id, visitor));
  signIn.exec("BEGIN");
  try {
    signIn.prepare("SELECT remote_clusters FROM users WHERE account_id=?").get(accountId);
    db.prepare("UPDATE users SET remote_clusters='[]' WHERE account_id=?").run(accountId);
    assert.equal(await projectVisible(made.id, visitor), true, "answered from what the sign-in connection reads now");
    assert.equal((await runAsAccount(visitor, () => getProject(made.id)))?.id, made.id);
    assert.deepEqual((await runAsAccount(visitor, () => listProjects())).map((record) => record.id), [made.id]);
  } finally { signIn.exec("COMMIT"); }
  assert.equal(await projectVisible(made.id, visitor), false, "its transaction ended without a write: an answer kept until the next write would still say yes");
  assert.equal(await runAsAccount(visitor, () => getProject(made.id)), undefined);
  assert.deepEqual(await runAsAccount(visitor, () => listProjects()), []);
  visit([cluster]);
  assert.equal(await projectVisible(made.id, visitor), true);

  const asked = queries(t);
  for (let i = 0; i < 5; i++) await projectVisible(made.id, visitor);
  assert.ok(asked.count() >= 5 * 4, `a visitor's answer is worked out on every call, got ${asked.count()} queries for 5 calls`);
});

test("the account helpers find a table once it is there, and forget one that a rollback took away", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jb-perf-access-accounts-"));
  const file = path.join(directory, "node.db");
  const db = new DatabaseSync(file), elsewhere = new DatabaseSync(file);
  t.after(() => { db.close(); elsewhere.close(); rmSync(directory, { recursive: true, force: true }); });
  const low = "00000000-0000-4000-8000-000000000001", high = "00000000-0000-4000-8000-000000000002";
  assert.equal(canonicalLocalHome(db), "", "no node table yet");
  db.exec("BEGIN");
  db.exec("CREATE TABLE cluster_node(singleton INTEGER PRIMARY KEY, id TEXT NOT NULL)");
  db.prepare("INSERT INTO cluster_node VALUES(1, ?)").run(high);
  assert.equal(canonicalLocalHome(db), high);
  db.exec("ROLLBACK");
  assert.equal(canonicalLocalHome(db), "", "the table went with the rollback, and was not remembered");

  elsewhere.exec("CREATE TABLE cluster_node(singleton INTEGER PRIMARY KEY, id TEXT NOT NULL)");
  elsewhere.prepare("INSERT INTO cluster_node VALUES(1, ?)").run(high);
  assert.equal(canonicalLocalHome(db), high, "made through another connection");
  elsewhere.exec("CREATE TABLE sharing_twins(left_node_id TEXT NOT NULL, right_node_id TEXT NOT NULL)");
  assert.equal(canonicalLocalHome(db), high);
  elsewhere.prepare("INSERT INTO sharing_twins VALUES(?, ?)").run(low, high);
  assert.equal(canonicalLocalHome(db), low, "twins share the lower id as their home");
  assert.equal(localAccountIdIn(db, "someone"), undefined, "no users table yet");
  elsewhere.exec("CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE, home_node_id TEXT)");
  elsewhere.prepare("INSERT INTO users VALUES('u1', 'someone', NULL)").run();
  assert.match(localAccountIdIn(db, "someone") ?? "", /^[0-9a-f]{32}$/);

  const prepare = DatabaseSync.prototype.prepare;
  let lookedFor = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) { if (sql.includes("sqlite_master")) lookedFor++; return prepare.call(this, sql); });
  for (let i = 0; i < 20; i++) { assert.equal(canonicalLocalHome(db), low); localAccountIdIn(db, "someone"); }
  assert.equal(lookedFor, 0, "tables that were found are not looked for again");
  elsewhere.prepare("DELETE FROM sharing_twins").run();
  assert.equal(canonicalLocalHome(db), high, "the rows are still read every time");
});
