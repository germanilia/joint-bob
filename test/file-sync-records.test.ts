import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePeerEndpointSchema, recordPeerEndpoint } from "../src/cluster-peer-endpoints.js";
import { ensureResourceSharingSchema } from "../src/cluster-sharing.js";
import { addSharingMember, createSharingCluster, getSharingCluster, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import { ensureControlSchema, listSettingsRecords } from "../src/file-sync/control.js";
import { acceptRecords } from "../src/file-sync/records.js";
import { EMPTY_RULE_SETTINGS, type SettingsRecord } from "../src/file-sync/types.js";

/* Design §6.4: a settings record counts only from the node that wrote it; newer wins by
   (updatedAt, origin). */

const LOCAL = "00000000-0000-4000-8000-000000000001";
const PEER = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";
const OUTSIDER = "00000000-0000-4000-8000-000000000004";
const CLUSTER = "10000000-0000-4000-8000-000000000001";
const OTHER_CLUSTER = "10000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureResourceSharingSchema(db);
  ensurePeerEndpointSchema(db);
  ensureControlSchema(db);
  return db;
}

function own(db: DatabaseSync, projectId: string, owner: string): void {
  registerOwnedResource(db, { kind: "project", id: projectId, ownerNodeId: owner }, LOCAL);
  db.prepare("INSERT INTO cluster_v2_resource_policy VALUES ('project', ?, ?, 1, 0)").run(projectId, owner);
}

function settings(key: string, overrides: Partial<SettingsRecord> = {}): SettingsRecord {
  return { key, value: { ...EMPTY_RULE_SETTINGS, userRules: ["*.wav"] }, updatedAt: at(0), origin: PEER, ...overrides };
}

const everything = { now: NOW, mayShare: () => true };

test("a settings record counts only from the node that wrote it, and a global one only for that node", () => {
  const db = database();
  const outcome = acceptRecords(db, LOCAL, {
    fromPeer: PEER,
    settings: [
      settings("project:alpha"),
      settings("project:alpha", { origin: OTHER, updatedAt: at(1) }),
      settings(`global:${PEER}`),
      settings(`global:${OTHER}`),
      settings("project:gamma"),
    ],
  }, { now: NOW, mayShare: (peer, projectId) => peer === PEER && projectId === "alpha" });
  assert.deepEqual(outcome, {
    settings: 2,
    rejected: [
      { record: "project:alpha", reason: "record was not written by its sender" },
      { record: `global:${OTHER}`, reason: "another node's global rules" },
      { record: "project:gamma", reason: "sender does not share the project with this node" },
    ],
  });
  assert.deepEqual(listSettingsRecords(db).map((record) => [record.key, record.origin]), [[`global:${PEER}`, PEER], ["project:alpha", PEER]]);
});

test("settings records order by time, then by origin", () => {
  const db = database();
  const send = (fromPeer: string, record: SettingsRecord) => acceptRecords(db, LOCAL, { fromPeer, settings: [record] }, everything).settings;
  assert.equal(send(PEER, settings("project:alpha", { updatedAt: at(1) })), 1);
  assert.equal(send(OTHER, settings("project:alpha", { origin: OTHER, updatedAt: at(0), value: { ...EMPTY_RULE_SETTINGS, userRules: ["older"] } })), 0, "an older write");
  assert.equal(send(OTHER, settings("project:alpha", { origin: OTHER, updatedAt: at(1), value: { ...EMPTY_RULE_SETTINGS, userRules: ["tie"] } })), 1, "the same time: the larger origin wins");
  assert.equal(send(PEER, settings("project:alpha", { updatedAt: at(1) })), 0, "and keeps winning that tie");
  assert.deepEqual(listSettingsRecords(db).map((record) => [record.origin, record.value.userRules]), [[OTHER, ["tie"]]]);
});

test("records from this node itself, with a timestamp that does not sort, or from the future are refused", () => {
  const db = database();
  assert.deepEqual(acceptRecords(db, LOCAL, { fromPeer: LOCAL, settings: [settings(`global:${LOCAL}`, { origin: LOCAL })] }, everything),
    { settings: 0, rejected: [{ record: "*", reason: "not from a peer" }] });
  const outcome = acceptRecords(db, LOCAL, {
    fromPeer: PEER,
    settings: [
      settings(`global:${PEER}`, { updatedAt: "2026-10-25T12:00:00Z" }), settings(`global:${PEER}`, { updatedAt: "2026-10-25T14:00:00.000+02:00" }),
      settings("project:alpha", { updatedAt: at(60) }), settings(`global:${PEER}`, { updatedAt: at(5) }),
    ],
  }, everything);
  assert.deepEqual(outcome, {
    settings: 1,
    rejected: [
      { record: "settings", reason: "invalid record" },
      { record: "settings", reason: "invalid record" },
      { record: "project:alpha", reason: "written in the future" },
    ],
  }, "an offset or a missing millisecond part would compare wrongly as text; five minutes ahead is clock skew");
  assert.deepEqual(listSettingsRecords(db).map((record) => [record.key, record.updatedAt]), [[`global:${PEER}`, at(5)]]);
});

test("a project's settings count from a peer the sharing policy lets hold that project", () => {
  const db = database();
  createSharingCluster(db, { id: CLUSTER, name: "main" }, LOCAL);
  addSharingMember(db, CLUSTER, LOCAL, PEER, getSharingCluster(db, CLUSTER).managerEpoch);
  createSharingCluster(db, { id: OTHER_CLUSTER, name: "other" }, LOCAL);
  addSharingMember(db, OTHER_CLUSTER, LOCAL, OUTSIDER, getSharingCluster(db, OTHER_CLUSTER).managerEpoch);
  for (const [cluster, node] of [[CLUSTER, PEER], [OTHER_CLUSTER, OUTSIDER]]) recordPeerEndpoint(db, { kind: "cluster", id: cluster }, { nodeId: node, name: node.slice(-4), url: `https://${node.slice(-4)}.example.com` });
  own(db, "alpha", LOCAL);
  setResourceShares(db, LOCAL, "project", "alpha", [{ clusterId: CLUSTER, projectId: null }]);
  const member = acceptRecords(db, LOCAL, { fromPeer: PEER, settings: [settings("project:alpha")] }, { now: NOW });
  const outsider = acceptRecords(db, LOCAL, { fromPeer: OUTSIDER, settings: [settings("project:alpha", { origin: OUTSIDER, updatedAt: at(1) })] }, { now: NOW });
  const unknown = acceptRecords(db, LOCAL, { fromPeer: PEER, settings: [settings("project:nowhere", { updatedAt: at(1) })] }, { now: NOW });
  assert.deepEqual([member.settings, outsider.rejected, unknown.rejected], [
    1,
    [{ record: "project:alpha", reason: "sender does not share the project with this node" }],
    [{ record: "project:nowhere", reason: "sender does not share the project with this node" }],
  ]);
  assert.deepEqual(listSettingsRecords(db).map((record) => record.origin), [PEER]);
});
