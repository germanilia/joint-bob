import { lstat, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Request, Response as HttpResponse, NextFunction } from "express";
import { z } from "zod";
import { agentResourcePaths } from "../agent-resources.js";
import { getClusterNode } from "../cluster.js";
import { isTrustedTwin, listSharingClusterMembers, listSharingMemberships, getSharingCluster } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { resolveDataDirectory } from "../data-directory.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { getOrCreateClusterIdentity } from "../cluster-identity.js";
import { getSettings } from "../settings.js";
import { authorizedSkillClusters, buildSkillBundle, ensureSkillSharingSchema, installSkillBundle, listReceivedScopedSkills, listReceivedSkills, setSkillShares, skillBundleDigest, skillClusterIds, skillDigest, skillNodeIds, skillScopeGrants, validateSkillName, type ReceivedScopedSkill, type ReceivedSkill, type SkillConversationGrant, type SkillScopeGrants } from "../skill-sharing.js";
import { allowSkillImport, backupRemovedSkill, markReceived, receivedOwner, skillSuppressed, suppressSkill, unlinkSkillAliases, unmarkReceived, withSkillMutation } from "../skill-sharing-files.js";
import { ensureResourceSharingSchema } from "../cluster-sharing.js";
import { scopedSkillDirectory, scopedSkillParent, writeScopedSkillIndex } from "../scoped-skills.js";
import { mayShareProject } from "./sharing-files.js";
import { sendError } from "./http-auth.js";
import { app } from "./state.js";
import { peerFetch } from "../relay/transport.js";
import { fetchRelaySkillBundle } from "../relay/skill-bundle.js";
import { relayPolicyLabel, relayPolicySubscriptions } from "../relay/resource-policy.js";
import { listMemberships, type RelayMembership } from "../relay/store.js";
import { peerAway } from "../peer-presence.js";
import { parseResourceFrontmatter } from "../skills.js";
import { noteTwinSkillRemoval, reconcileTwinSkills, registerTwinSkillSyncRoutes } from "./twin-skill-sync.js";

const nameSchema = z.string().min(1).max(200).refine((value) => { try { validateSkillName(value); return true; } catch { return false; } });
const conversationGrantSchema = z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(300) }).strict();
const selectionSchema = z.object({
  clusterIds: z.array(z.string().uuid()).max(100),
  nodeIds: z.array(z.string().uuid()).max(100).default([]),
  projectIds: z.array(z.string().min(1).max(200)).max(100).default([]),
  workspaceIds: z.array(z.string().min(1).max(300)).max(100).default([]),
  conversations: z.array(conversationGrantSchema).max(200).default([]),
}).strict();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const manifestSchema = z.object({ ownerNodeId: z.string().uuid(), skills: z.array(z.object({ name: nameSchema, digest: digestSchema }).strict()).max(512) }).strict()
  .refine((value) => new Set(value.skills.map((skill) => skill.name.toLowerCase())).size === value.skills.length, "Duplicate skill names");
const scopedManifestSchema = z.object({ ownerNodeId: z.string().uuid(), skills: z.array(z.object({ name: nameSchema, digest: digestSchema,
  projectIds: z.array(z.string().min(1).max(200)).max(500), conversations: z.array(conversationGrantSchema).max(500) }).strict()).max(512) }).strict()
  .refine((value) => new Set(value.skills.map((skill) => skill.name.toLowerCase())).size === value.skills.length, "Duplicate skill names");
const bundleReplySchema = z.object({ name: nameSchema, digest: digestSchema, bundle: z.unknown() }).strict();
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_BUNDLE_RESPONSE_BYTES = 4 * 1024 * 1024;
let refresh: Promise<void> | undefined;

function failure(message: string, status = 409): Error { return Object.assign(new Error(message), { status }); }
/** Skills a relay enforces are received from the relay, not from a cluster peer; its owner id says so. */
export const relayOwnerId = (relayNodeId: string): string => `relay:${relayNodeId}`;
export const relayOwned = (owner: string | undefined): boolean => Boolean(owner?.startsWith("relay:"));

function commonClusters(db: DatabaseSync, local: string, peer: string): string[] {
  return listSharingMemberships(db, local).map((membership) => membership.clusterId).filter((id) =>
    !getSharingCluster(db, id).closed && listSharingClusterMembers(db, id).some((member) => member.nodeId === peer));
}
function requirePeer(db: DatabaseSync, local: string, peer: string, clusterId?: string): string {
  const clusters = commonClusters(db, local, peer);
  const id = clusterId ? clusters.find((candidate) => candidate === clusterId) : clusters[0];
  if (!id) throw failure("Forbidden", 403);
  return id;
}

async function existing(directory: string): Promise<boolean> {
  try { await lstat(directory); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Waits for all the reads at once and keeps their order, so the failure thrown is the one that came first when they ran one by one. */
async function together<T>(reads: Array<Promise<T>>): Promise<T[]> {
  return (await Promise.allSettled(reads)).map((read) => { if (read.status === "rejected") throw read.reason; return read.value; });
}
async function managedNames(): Promise<string[]> {
  const root = agentResourcePaths().sharedSkills;
  if (!await existing(root)) return [];
  if (!(await lstat(root)).isDirectory()) throw failure("Managed skills root must be a real directory");
  const folders = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
  // All folders are checked at once. One by one this was two waits per skill on every listing.
  const listed = await together(folders.map(async (name) => await existing(path.join(root, name, "SKILL.md")) && !await skillSuppressed(root, name)));
  return folders.filter((_, index) => listed[index]).sort();
}
function aliasRoots(): string[] {
  const settings = getSettings();
  return [path.join(os.homedir(), ".agents/skills"), path.join(settings.pi.configPath, "skills"), path.join(settings.claude.configPath, "skills")];
}
async function removeReceived(db: DatabaseSync, prior: ReceivedSkill): Promise<void> {
  db.prepare("INSERT OR IGNORE INTO revoked_scoped_skills VALUES(?)").run(prior.name);
  const destination = path.join(agentResourcePaths().sharedSkills, prior.name);
  if (await existing(destination)) {
    if (await skillDigest(destination, prior.name) !== prior.digest) throw failure(`Modified received skill preserved: ${prior.name}`);
    await backupRemovedSkill(destination);
  }
  await unlinkSkillAliases(destination, aliasRoots());
  await unmarkReceived(agentResourcePaths().sharedSkills, prior.name);
  db.prepare("DELETE FROM received_skills WHERE owner_node_id=? AND name=?").run(prior.ownerNodeId, prior.name);
}

function relayLabel(db: DatabaseSync, owner: string): string {
  const relay = listMemberships(db).find((item) => relayOwnerId(item.relayNodeId ?? "") === owner);
  return relay ? relayPolicyLabel(relay) : "a relay";
}

async function localView() {
  const db = await clusterV2Database(), node = await getClusterNode();
  ensureSkillSharingSchema(db);
  const received = listReceivedSkills(db);
  const nodeName = db.prepare("SELECT name FROM cluster_v2_membership_nodes WHERE cluster_id=? AND node_id=?");
  const nodes = new Map<string, { nodeId: string; name: string; twin: boolean; clusterIds: string[] }>();
  const clusters = listSharingMemberships(db, node.id).map((membership) => getSharingCluster(db, membership.clusterId)).filter((cluster) => !cluster.closed).map((cluster) => {
    const members = listSharingClusterMembers(db, cluster.id).filter((member) => member.nodeId !== node.id).map((member) => {
      const name = (nodeName.get(cluster.id, member.nodeId) as { name: string | null } | undefined)?.name || member.nodeId;
      const known = nodes.get(member.nodeId) ?? { nodeId: member.nodeId, name, twin: isTrustedTwin(db, node.id, member.nodeId), clusterIds: [] };
      known.clusterIds.push(cluster.id);
      nodes.set(member.nodeId, known);
      return { nodeId: member.nodeId, name };
    });
    return { ...cluster, members };
  });
  const skills = [];
  for (const name of await managedNames()) {
    const source = received.find((item) => item.name === name);
    const owner = source?.ownerNodeId ?? await receivedOwner(agentResourcePaths().sharedSkills, name);
    const scopes = owner ? { workspaceIds: [], projectIds: [], conversations: [] } : skillScopeGrants(db, name);
    const description = parseResourceFrontmatter(await readFile(path.join(agentResourcePaths().sharedSkills, name, "SKILL.md"), "utf8")).description ?? "";
    skills.push({ name, description, path: await realpath(path.join(agentResourcePaths().sharedSkills, name)), kind: owner ? "received" : "local",
      clusterIds: owner ? [] : skillClusterIds(db, node.id, name), nodeIds: owner ? [] : skillNodeIds(db, node.id, name), ...scopes,
      receivedFrom: owner, receivedFromName: owner ? relayOwned(owner) ? relayLabel(db, owner) : nodes.get(owner)?.name ?? owner : null, managedByRelay: relayOwned(owner), lastSync: source?.updatedAt });
  }
  const peerStatus = (db.prepare("SELECT owner_node_id AS ownerNodeId,last_success AS lastSuccess,last_error AS error FROM skill_peer_status").all() as Array<{ ownerNodeId: string; lastSuccess: string | null; error: string | null }>)
    .map((status) => ({ ...status, ownerName: relayOwned(status.ownerNodeId) ? relayLabel(db, status.ownerNodeId) : nodes.get(status.ownerNodeId)?.name ?? status.ownerNodeId }));
  // Workspaces this node owns; a received "Shared projects" workspace belongs to its owner.
  const registry = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cluster_v2_project_workspaces'").get();
  const workspaces = db.prepare(`SELECT w.id,w.label FROM workspaces w${registry ? " WHERE NOT EXISTS (SELECT 1 FROM cluster_v2_project_workspaces r WHERE r.workspace_id=w.id)" : ""} ORDER BY w.label,w.id`).all() as Array<{ id: string; label: string }>;
  return { clusters, nodes: [...nodes.values()].sort((left, right) => left.name.localeCompare(right.name)), workspaces, skills, peerStatus };
}

/** Where a receiver may load a skill when no cluster or node grant gives it the whole skill. */
function scopedGrantFor(db: DatabaseSync, owner: string, receiver: string, name: string): { projectIds: string[]; conversations: SkillConversationGrant[] } {
  const scopes = skillScopeGrants(db, name);
  if (!scopes.workspaceIds.length && !scopes.projectIds.length && !scopes.conversations.length) return { projectIds: [], conversations: [] };
  ensureResourceSharingSchema(db);
  const shared = (projectId: string) => mayShareProject(db, owner, receiver, projectId);
  const projectIds = new Set<string>(scopes.projectIds.filter(shared));
  const inWorkspace = db.prepare("SELECT id FROM projects WHERE workspace_id=? ORDER BY id");
  for (const workspaceId of scopes.workspaceIds) {
    for (const { id } of inWorkspace.all(workspaceId) as Array<{ id: string }>) if (shared(id)) projectIds.add(id);
  }
  const conversations = scopes.conversations.filter((item) => !projectIds.has(item.projectId) && shared(item.projectId));
  return { projectIds: [...projectIds], conversations };
}
function scopedOnly(db: DatabaseSync, owner: string, receiver: string, name: string) {
  if (authorizedSkillClusters(db, owner, receiver, name).length) return undefined;
  const grant = scopedGrantFor(db, owner, receiver, name);
  return grant.projectIds.length || grant.conversations.length ? grant : undefined;
}

/** One of this node's own skills as a walk found it. Without `outcome` nobody is granted the skill, so it was not looked at. */
interface OwnSkill { name: string; outcome?: { digest: string } | { error: unknown } }
let waitingWalk: Promise<OwnSkill[]> | undefined;
/**
 * The digests of this node's own skills, for the manifest routes. Every peer's request needs the
 * same walk of the skills folder, so requests share it. Before, each one walked the folder alone and
 * they queued behind one another in the mutation lock.
 *
 * A request joins only a walk that has not begun. Once a walk reads the disk, a later request waits
 * for the next one, so no answer misses a change made before its request arrived. At most one walk
 * runs and one waits, however many peers ask.
 *
 * The walk still runs inside the mutation lock. A skill is never listed while an install has moved
 * it away, and a walk is a look at each folder (skillDigest), so the lock is held briefly.
 */
function ownSkillDigests(db: DatabaseSync): Promise<OwnSkill[]> {
  waitingWalk ??= withSkillMutation(async () => {
    waitingWalk = undefined;
    const root = agentResourcePaths().sharedSkills, names = await managedNames();
    const owners = await together(names.map((name) => receivedOwner(root, name)));
    // Every per-receiver check starts from these rows. A name without one is granted to nobody, so its files are left alone.
    ensureSkillSharingSchema(db);
    const granted = new Set((db.prepare("SELECT name FROM skill_shares UNION SELECT name FROM skill_node_shares UNION SELECT name FROM skill_scope_shares").all() as Array<{ name: string }>).map((row) => row.name));
    return Promise.all(names.filter((_, index) => !owners[index]).map(async (name): Promise<OwnSkill> => {
      if (!granted.has(name)) return { name };
      try { return { name, outcome: { digest: await skillDigest(path.join(root, name), name) } }; }
      catch (error) { return { name, outcome: { error } }; }
    }));
  });
  return waitingWalk;
}

async function scopedManifestFor(receiver: string) {
  const db = await clusterV2Database(), owner = (await getClusterNode()).id;
  requirePeer(db, owner, receiver);
  const skills = [];
  for (const { name, outcome } of await ownSkillDigests(db)) {
    // A folder whose name is no skill name fails the grant checks. A skill without grants skips them, so its name is checked here.
    if (!outcome) { validateSkillName(name); continue; }
    const grant = scopedOnly(db, owner, receiver, name);
    if (!grant) continue;
    if ("error" in outcome) throw outcome.error;
    skills.push({ name, digest: outcome.digest, ...grant });
  }
  requirePeer(db, owner, receiver);
  const result = scopedManifestSchema.parse({ ownerNodeId: owner, skills });
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_MANIFEST_BYTES) throw failure("Skill manifest exceeds limit", 413);
  return result;
}

async function manifestFor(receiver: string) {
  const db = await clusterV2Database(), owner = (await getClusterNode()).id;
  requirePeer(db, owner, receiver);
  const skills = [];
  for (const { name, outcome } of await ownSkillDigests(db)) {
    if (!outcome) { validateSkillName(name); continue; }
    // Grants are read after the walk, so a skill unshared while it ran is not listed. A skill that cannot be bundled fails only the receivers it is shared with.
    if (!authorizedSkillClusters(db, owner, receiver, name).length) continue;
    if ("error" in outcome) throw outcome.error;
    skills.push({ name, digest: outcome.digest });
  }
  requirePeer(db, owner, receiver);
  const result = manifestSchema.parse({ ownerNodeId: owner, skills });
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_MANIFEST_BYTES) throw failure("Skill manifest exceeds limit", 413);
  return result;
}
async function bundleFor(receiver: string, name: string) {
  const db = await clusterV2Database(), owner = (await getClusterNode()).id;
  const authorized = async () => {
    if ((!authorizedSkillClusters(db, owner, receiver, name).length && !scopedOnly(db, owner, receiver, name)) || await receivedOwner(agentResourcePaths().sharedSkills, name)
      || await skillSuppressed(agentResourcePaths().sharedSkills, name)) throw failure("Forbidden", 403);
  };
  await authorized();
  return withSkillMutation(async () => {
    await authorized();
    const result = await buildSkillBundle(path.join(agentResourcePaths().sharedSkills, name), name);
    await authorized();
    return { name, ...result };
  });
}

async function readBounded(response: Response, limit: number): Promise<unknown> {
  if (Number(response.headers.get("Content-Length") ?? "0") > limit) {
    await response.body?.cancel(); throw failure("Cluster peer response exceeds limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure("Cluster peer returned an empty response");
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw failure("Cluster peer response exceeds limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); }
}
async function signedSkillPost(db: DatabaseSync, local: string, peer: string, cluster: string, target: string, payload: unknown, limit: number, missingOk = false) {
  requirePeer(db, local, peer, cluster);
  const descriptor = db.prepare("SELECT url FROM cluster_v2_membership_nodes WHERE cluster_id=? AND node_id=?").get(cluster, peer) as { url: string };
  const body = Buffer.from(JSON.stringify(payload));
  const response = await peerFetch(new URL(target, descriptor.url), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), body,
    headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local, peer, "POST", target, body) },
  }, peer);
  // An owner on an older release has no scoped manifest, so it grants nothing scoped.
  if (missingOk && response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw failure(`Cluster peer request failed (${response.status})`, 503); }
  const result = await readBounded(response, limit);
  requirePeer(db, local, peer, cluster);
  return result;
}

async function installOffered(db: DatabaseSync, local: string, owner: string, cluster: string, offered: { name: string; digest: string }): Promise<void> {
  const root = agentResourcePaths().sharedSkills, destination = path.join(root, offered.name);
  if (await skillSuppressed(root, offered.name)) return;
  // A relay this node follows enforces this name; its copy wins over a cluster peer's.
  if (relayOwned(await receivedOwner(root, offered.name))) return;
  const unchanged = await withSkillMutation(async () => {
    const received = listReceivedSkills(db).filter((item) => item.name === offered.name);
    const prior = received.find((item) => item.ownerNodeId === owner);
    // A name another owner or this node's own skill holds is refused before the download: the
    // check after it failed the same way on every pass, and each pass fetched the bundle again.
    const provenance = await receivedOwner(root, offered.name);
    if (received.some((item) => item.ownerNodeId !== owner) || (provenance && provenance !== owner) || (!prior && await existing(destination))) throw failure(`Skill name conflict: ${offered.name}`);
    if (!prior || !await existing(destination)) return false;
    if (await skillDigest(destination, offered.name) !== prior.digest) throw failure(`Modified received skill preserved: ${offered.name}`);
    if (prior.digest !== offered.digest) return false;
    db.prepare("DELETE FROM revoked_scoped_skills WHERE name=?").run(offered.name);
    return true;
  });
  if (unchanged) return;
  const fetched = bundleReplySchema.parse(await signedSkillPost(db, local, owner, cluster, "/api/cluster/v2/skills/bundle", { name: offered.name }, MAX_BUNDLE_RESPONSE_BYTES));
  if (fetched.name !== offered.name || fetched.digest !== offered.digest || skillBundleDigest(fetched.bundle) !== offered.digest) throw failure("Skill digest mismatch");
  await withSkillMutation(async () => {
    requirePeer(db, local, owner, cluster);
    if (await skillSuppressed(root, offered.name)) return;
    const prior = listReceivedSkills(db).find((item) => item.name === offered.name);
    const provenance = await receivedOwner(root, offered.name);
    if ((prior && prior.ownerNodeId !== owner) || (provenance && provenance !== owner)) throw failure(`Skill name conflict: ${offered.name}`);
    if (await existing(destination)) {
      if (!prior) throw failure(`Skill name conflict: ${offered.name}`);
      const actual = await skillDigest(destination, offered.name);
      if (actual !== prior.digest) throw failure(`Modified received skill preserved: ${offered.name}`);
      if (actual === offered.digest) return;
    }
    await markReceived(root, offered.name, owner);
    await installSkillBundle(fetched.bundle, offered.name, destination, path.join(resolveDataDirectory(), "skill-staging"));
    db.prepare("INSERT OR REPLACE INTO received_skills VALUES(?,?,?,?)").run(owner, offered.name, offered.digest, new Date().toISOString());
    db.prepare("DELETE FROM revoked_scoped_skills WHERE name=?").run(offered.name);
    try { requirePeer(db, local, owner, cluster); }
    catch (error) {
      await removeReceived(db, { ownerNodeId: owner, name: offered.name, digest: offered.digest, updatedAt: new Date().toISOString() });
      throw error;
    }
  });
}
async function removeScoped(db: DatabaseSync, prior: ReceivedScopedSkill): Promise<void> {
  // Revoke runtime access even when a locally modified copy must be preserved.
  if (!listReceivedSkills(db).some((item) => item.name === prior.name)) db.prepare("INSERT OR IGNORE INTO revoked_scoped_skills VALUES(?)").run(prior.name);
  const destination = scopedSkillDirectory(prior.name);
  if (await existing(destination)) {
    if (await skillDigest(destination, prior.name) !== prior.digest) throw failure(`Modified received skill preserved: ${prior.name}`);
    await backupRemovedSkill(destination);
  }
  await rm(scopedSkillParent(prior.name), { recursive: true, force: true });
  db.prepare("DELETE FROM received_scoped_skills WHERE owner_node_id=? AND name=?").run(prior.ownerNodeId, prior.name);
}

type ScopedOffer = { name: string; digest: string; projectIds: string[]; conversations: SkillConversationGrant[] };
async function installScoped(db: DatabaseSync, local: string, owner: string, cluster: string, offered: ScopedOffer): Promise<void> {
  const destination = scopedSkillDirectory(offered.name);
  const scope = [JSON.stringify(offered.projectIds), JSON.stringify(offered.conversations)];
  // A scoped copy never shadows a skill every conversation here already loads.
  const assertNoConflict = async () => {
    const other = listReceivedScopedSkills(db).find((item) => item.name === offered.name && item.ownerNodeId !== owner);
    if (other || (await managedNames()).includes(offered.name)) throw failure(`Skill name conflict: ${offered.name}`);
  };
  const unchanged = await withSkillMutation(async () => {
    const prior = listReceivedScopedSkills(db).find((item) => item.name === offered.name && item.ownerNodeId === owner);
    if (!prior) { await assertNoConflict(); return false; }
    // Scope changes revoke access even if local edits prevent a content update.
    db.prepare("UPDATE received_scoped_skills SET project_ids=?,conversations=? WHERE owner_node_id=? AND name=?").run(...scope, owner, offered.name);
    await assertNoConflict();
    if (!await existing(destination)) return false;
    if (await skillDigest(destination, offered.name) !== prior.digest) throw failure(`Modified received skill preserved: ${offered.name}`);
    if (prior.digest !== offered.digest) return false;
    db.prepare("DELETE FROM revoked_scoped_skills WHERE name=?").run(offered.name);
    return true;
  });
  if (unchanged) return;
  const fetched = bundleReplySchema.parse(await signedSkillPost(db, local, owner, cluster, "/api/cluster/v2/skills/bundle", { name: offered.name }, MAX_BUNDLE_RESPONSE_BYTES));
  if (fetched.name !== offered.name || fetched.digest !== offered.digest || skillBundleDigest(fetched.bundle) !== offered.digest) throw failure("Skill digest mismatch");
  await withSkillMutation(async () => {
    requirePeer(db, local, owner, cluster);
    await assertNoConflict();
    const prior = listReceivedScopedSkills(db).find((item) => item.name === offered.name);
    if (await existing(destination)) {
      if (!prior) throw failure(`Skill name conflict: ${offered.name}`);
      if (await skillDigest(destination, offered.name) !== prior.digest) throw failure(`Modified received skill preserved: ${offered.name}`);
    }
    await installSkillBundle(fetched.bundle, offered.name, destination, path.join(resolveDataDirectory(), "skill-staging"));
    db.prepare("INSERT OR REPLACE INTO received_scoped_skills VALUES(?,?,?,?,?,?)").run(owner, offered.name, offered.digest, new Date().toISOString(), ...scope);
    db.prepare("DELETE FROM revoked_scoped_skills WHERE name=?").run(offered.name);
  });
}
async function syncScopedOwner(db: DatabaseSync, local: string, owner: string, cluster: string, errors: Error[]): Promise<void> {
  const reply = await signedSkillPost(db, local, owner, cluster, "/api/cluster/v2/skills/scoped-manifest", {}, MAX_MANIFEST_BYTES, true);
  const manifest = reply === null ? { ownerNodeId: owner, skills: [] } : scopedManifestSchema.parse(reply);
  if (manifest.ownerNodeId !== owner) throw failure("Peer returned the wrong owner");
  for (const offered of manifest.skills) {
    try { await installScoped(db, local, owner, cluster, offered); }
    catch (error) { errors.push(error as Error); }
  }
  await withSkillMutation(async () => {
    requirePeer(db, local, owner, cluster);
    for (const prior of listReceivedScopedSkills(db).filter((item) => item.ownerNodeId === owner && !manifest.skills.some((skill) => skill.name === item.name))) {
      try { await removeScoped(db, prior); } catch (error) { errors.push(error as Error); }
    }
  });
}
function writeScopedIndex(db: DatabaseSync): void {
  writeScopedSkillIndex(listReceivedScopedSkills(db).map(({ name, projectIds, conversations }) => ({ name, projectIds, conversations })));
}

function recordPeerError(db: DatabaseSync, owner: string, error: unknown): void {
  db.prepare("INSERT INTO skill_peer_status(owner_node_id,last_error) VALUES(?,?) ON CONFLICT(owner_node_id) DO UPDATE SET last_error=excluded.last_error")
    .run(owner, (error as Error).message);
}
/**
 * How each owner is asked for what it shares here.
 *
 * Owners say when a skill or its sharing changes (/skills/changed) and are asked when they return,
 * so the 30-second maintenance pass asks one again only after OWNER_RECHECK_MS. That catches a
 * skill edited on disk, which nothing announces.
 *
 * One sync runs per owner at a time. A notice, a return or a refresh that comes during it gets one
 * more sync after it, because the running one may have read the owner's list before whatever
 * prompted the request. Ten notices during one sync lead to one more sync, not ten. Before, each
 * started a sync of its own beside the running one.
 */
interface OwnerPace {
  /** When a sync with this owner last started. */
  askedAt: number;
  running?: Promise<void>;
  /** The one sync that starts when the running one ends, shared by everything that asked meanwhile. */
  following?: Promise<void>;
}
const ownerPaces = new Map<string, OwnerPace>();
const OWNER_RECHECK_MS = 10 * 60_000;
function paceOf(owner: string): OwnerPace {
  let pace = ownerPaces.get(owner);
  if (!pace) ownerPaces.set(owner, pace = { askedAt: 0 });
  return pace;
}
/** Asks one owner, never twice at once. Resolves when a sync that started after this call has ended. */
function askOwner(db: DatabaseSync, local: string, owner: string, cluster: string): Promise<void> {
  const pace = paceOf(owner);
  if (pace.following) return pace.following;
  if (pace.running) {
    const next = (): Promise<void> => { pace.following = undefined; return askOwner(db, local, owner, cluster); };
    return pace.following = pace.running.then(next, next);
  }
  return pace.running = syncOwner(db, local, owner, cluster, pace).finally(() => { pace.running = undefined; });
}
async function syncOwner(db: DatabaseSync, local: string, owner: string, cluster: string, pace: OwnerPace): Promise<void> {
  pace.askedAt = Date.now();
  try {
    const manifest = manifestSchema.parse(await signedSkillPost(db, local, owner, cluster, "/api/cluster/v2/skills/manifest", {}, MAX_MANIFEST_BYTES));
    if (manifest.ownerNodeId !== owner) throw failure("Peer returned the wrong owner");
    const errors: Error[] = [];
    for (const offered of manifest.skills) {
      try { await installOffered(db, local, owner, cluster, offered); }
      catch (error) { errors.push(error as Error); }
    }
    await withSkillMutation(async () => {
      requirePeer(db, local, owner, cluster);
      for (const prior of listReceivedSkills(db).filter((item) => item.ownerNodeId === owner && !manifest.skills.some((skill) => skill.name === item.name))) {
        try { await removeReceived(db, prior); } catch (error) { errors.push(error as Error); }
      }
    });
    await syncScopedOwner(db, local, owner, cluster, errors);
    if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
    db.prepare("INSERT OR REPLACE INTO skill_peer_status VALUES(?,?,NULL)").run(owner, new Date().toISOString());
  } catch (error) { recordPeerError(db, owner, error); }
}
async function syncSkills(force: boolean): Promise<void> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureSkillSharingSchema(db);
  const peers = new Map<string, string>();
  for (const membership of listSharingMemberships(db, local)) {
    if (getSharingCluster(db, membership.clusterId).closed) continue;
    for (const member of listSharingClusterMembers(db, membership.clusterId)) if (member.nodeId !== local) peers.set(member.nodeId, membership.clusterId);
  }
  await withSkillMutation(async () => {
    for (const prior of listReceivedSkills(db)) if (!peers.has(prior.ownerNodeId) && !relayOwned(prior.ownerNodeId)) {
      try { await removeReceived(db, prior); }
      catch (error) { recordPeerError(db, prior.ownerNodeId, error); }
    }
    for (const prior of listReceivedScopedSkills(db)) if (!peers.has(prior.ownerNodeId) && !relayOwned(prior.ownerNodeId)) {
      try { await removeScoped(db, prior); }
      catch (error) { recordPeerError(db, prior.ownerNodeId, error); }
    }
  });
  // No mutation lock spans network I/O: two owners can pull from one another.
  // An owner that is away keeps what it shared here; it is asked again when it returns.
  try { await Promise.all([...peers].filter(([owner]) => !peerAway(owner) && (force || Date.now() - paceOf(owner).askedAt >= OWNER_RECHECK_MS)).map(([owner, cluster]) => askOwner(db, local, owner, cluster))); }
  finally { writeScopedIndex(db); }
}
/**
 * Installs one skill a followed relay enforces. The relay's configuration wins every conflict:
 * a local skill, a copy received from a cluster peer, a dismissed copy or a local edit under the
 * same name is backed up and replaced. Returns true when files changed.
 */
async function installRelaySkill(db: DatabaseSync, local: string, relay: RelayMembership, name: string, digest: string): Promise<boolean> {
  const root = agentResourcePaths().sharedSkills, destination = path.join(root, name), owner = relayOwnerId(relay.relayNodeId!);
  const current = async () => {
    const prior = listReceivedSkills(db).find((item) => item.name === name);
    return prior?.ownerNodeId === owner && await receivedOwner(root, name) === owner && !await skillSuppressed(root, name)
      && await existing(destination) && await skillDigest(destination, name) === digest;
  };
  if (await withSkillMutation(current)) return false;
  const bundle = await fetchRelaySkillBundle(db, local, relay, name, digest);
  return withSkillMutation(async () => {
    if (await current()) return false;
    await allowSkillImport(root, name);
    if (await existing(destination)) {
      const ownCopy = !await receivedOwner(root, name);
      const backup = await backupRemovedSkill(destination);
      // This node's own skill comes back when the relay stops enforcing the name; received copies are fetched again by their owner.
      if (ownCopy) db.prepare("INSERT OR IGNORE INTO relay_replaced_skills(name,backup) VALUES(?,?)").run(name, backup);
      console.warn(`Relay ${relayPolicyLabel(relay)} enforces skill ${name}; the copy it replaced is kept at ${backup}`);
    }
    db.prepare("DELETE FROM received_skills WHERE name=?").run(name);
    await markReceived(root, name, owner);
    await installSkillBundle(bundle, name, destination, path.join(resolveDataDirectory(), "skill-staging"));
    db.prepare("INSERT INTO received_skills VALUES(?,?,?,?)").run(owner, name, digest, new Date().toISOString());
    db.prepare("DELETE FROM revoked_scoped_skills WHERE name=?").run(name);
    return true;
  });
}

/**
 * A relay stopped enforcing a skill: an untouched copy goes and the node's own skill it replaced comes
 * back; a copy edited here stays as this node's own skill, and the older original stays in the backups.
 */
async function removeRelaySkill(db: DatabaseSync, prior: ReceivedSkill): Promise<void> {
  const root = agentResourcePaths().sharedSkills, destination = path.join(root, prior.name);
  const replaced = db.prepare("SELECT backup FROM relay_replaced_skills WHERE name=?").get(prior.name) as { backup: string } | undefined;
  if (await existing(destination) && await skillDigest(destination, prior.name) !== prior.digest) {
    await unmarkReceived(root, prior.name);
    db.prepare("DELETE FROM received_skills WHERE owner_node_id=? AND name=?").run(prior.ownerNodeId, prior.name);
    db.prepare("DELETE FROM relay_replaced_skills WHERE name=?").run(prior.name);
    console.warn(`Relay no longer enforces ${prior.name}; the copy edited on this node stays as a local skill`);
    return;
  }
  await removeReceived(db, prior);
  // removeReceived marks the name revoked, which hides every copy of it; a relay stepping back is not a
  // revocation, so the node's own copy and native copies with the name load again.
  db.prepare("DELETE FROM revoked_scoped_skills WHERE name=?").run(prior.name);
  if (replaced && await existing(replaced.backup) && !await existing(destination)) {
    await rename(replaced.backup, destination);
    console.warn(`Relay no longer enforces ${prior.name}; this node's own copy is restored`);
  }
  db.prepare("DELETE FROM relay_replaced_skills WHERE name=?").run(prior.name);
}

let relaySync: Promise<boolean> | undefined;
/**
 * Downloads the skills that admitted relays enforce and removes the ones they no longer do.
 * Resolves true when files changed, so the caller can reload open conversations.
 */
export function syncRelaySkills(): Promise<boolean> {
  if (!relaySync) relaySync = syncRelaySkillsNow().finally(() => { relaySync = undefined; });
  return relaySync;
}
async function syncRelaySkillsNow(): Promise<boolean> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureSkillSharingSchema(db);
  db.exec("CREATE TABLE IF NOT EXISTS relay_replaced_skills(name TEXT PRIMARY KEY, backup TEXT NOT NULL)");
  // Downloads are signed with this node's identity, the one it proved to the relay when it joined.
  getOrCreateClusterIdentity(db, local);
  const wanted = new Map<string, { relay: RelayMembership; digest: string }>();
  for (const { relay, statement } of relayPolicySubscriptions(db)) {
    if (!statement || !relay.relayNodeId || !statement.body.settings.skills.enforce) continue;
    for (const [name, digest] of Object.entries(statement.body.skillDigests ?? {})) if (!wanted.has(name)) wanted.set(name, { relay, digest });
  }
  let changed = false;
  const errors = new Map<string, Error[]>();
  const note = (owner: string, error: unknown) => errors.set(owner, [...errors.get(owner) ?? [], error as Error]);
  const unreachable = new Set<string>();
  for (const [name, { relay, digest }] of wanted) {
    const owner = relayOwnerId(relay.relayNodeId!);
    if (unreachable.has(owner)) continue;
    try { if (await installRelaySkill(db, local, relay, name, digest)) changed = true; }
    catch (error) {
      note(owner, error);
      // A network failure or timeout means the relay is unreachable now; it pushes its policy again on reconnect.
      if (error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) unreachable.add(owner);
    }
  }
  await withSkillMutation(async () => {
    for (const prior of listReceivedSkills(db).filter((item) => relayOwned(item.ownerNodeId))) {
      const keep = wanted.get(prior.name);
      if (keep && relayOwnerId(keep.relay.relayNodeId!) === prior.ownerNodeId) continue;
      try { await removeRelaySkill(db, prior); changed = true; } catch (error) { note(prior.ownerNodeId, error); }
    }
  });
  for (const owner of new Set([...[...wanted.values()].map(({ relay }) => relayOwnerId(relay.relayNodeId!)), ...errors.keys()])) {
    const failed = errors.get(owner);
    if (failed?.length) recordPeerError(db, owner, new Error(failed.map((error) => error.message).join("; ")));
    else db.prepare("INSERT OR REPLACE INTO skill_peer_status VALUES(?,?,NULL)").run(owner, new Date().toISOString());
  }
  // A relay this node left, or that delivers nothing now, leaves no sync status behind.
  const current = new Set([...[...wanted.values()].map(({ relay }) => relayOwnerId(relay.relayNodeId!)), ...errors.keys()]);
  for (const { owner_node_id: owner } of db.prepare("SELECT owner_node_id FROM skill_peer_status WHERE owner_node_id LIKE 'relay:%'").all() as Array<{ owner_node_id: string }>) {
    if (!current.has(owner)) db.prepare("DELETE FROM skill_peer_status WHERE owner_node_id=?").run(owner);
  }
  return changed;
}

/** `force` asks every present owner now (a person pressed refresh); otherwise only owners not asked for OWNER_RECHECK_MS. */
export async function refreshSharedSkills(force = false): Promise<void> {
  if (force && refresh) await refresh.catch(() => undefined);
  if (!refresh) refresh = syncSkills(force).then(() => reconcileTwinSkills()).finally(() => { refresh = undefined; });
  return refresh;
}

/** A peer that was away answers again: what it shares here is fetched now. */
export async function refreshSkillsFrom(owner: string): Promise<void> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureSkillSharingSchema(db);
  let cluster: string;
  try { cluster = requirePeer(db, local, owner); } catch { return; }
  await askOwner(db, local, owner, cluster);
  writeScopedIndex(db);
}

/** Sharing of a skill changed: every present peer in this node's clusters looks again, so a revoked copy goes at once. */
async function announceSharingChange(): Promise<void> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  const peers = new Map<string, string>();
  for (const membership of listSharingMemberships(db, local)) {
    if (getSharingCluster(db, membership.clusterId).closed) continue;
    for (const member of listSharingClusterMembers(db, membership.clusterId)) if (member.nodeId !== local) peers.set(member.nodeId, membership.clusterId);
  }
  await Promise.all([...peers].filter(([peer]) => !peerAway(peer)).map(async ([peer, cluster]) => {
    try { await signedSkillPost(db, local, peer, cluster, "/api/cluster/v2/skills/changed", {}, 4096, true); }
    catch (error) { console.warn(`Skill sharing notice to ${peer} failed: ${(error as Error).message}`); }
  }));
}

/** Peers that receive at least one of these skills from this node, each with a cluster to reach it through. */
function skillReceivers(db: DatabaseSync, local: string, names: string[]): Map<string, string> {
  const receivers = new Map<string, string>();
  for (const membership of listSharingMemberships(db, local)) {
    if (getSharingCluster(db, membership.clusterId).closed) continue;
    for (const member of listSharingClusterMembers(db, membership.clusterId)) {
      if (member.nodeId === local || receivers.has(member.nodeId)) continue;
      if (names.some((name) => authorizedSkillClusters(db, local, member.nodeId, name).length || scopedOnly(db, local, member.nodeId, name))) receivers.set(member.nodeId, membership.clusterId);
    }
  }
  return receivers;
}

/**
 * Tells the nodes a changed skill is shared with to fetch it now, so they run the new version
 * without waiting for their next refresh. Nodes that are away catch up when they return.
 */
export async function announceSkillChanges(names: string[]): Promise<void> {
  void reconcileTwinSkills().catch((error) => console.warn(`Twin skill sync pending: ${(error as Error).message}`));
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureSkillSharingSchema(db);
  const valid = names.filter((name) => { try { validateSkillName(name); return true; } catch { return false; } });
  const managed = await managedNames(), owned = [];
  for (const name of valid) if (managed.includes(name) && !await receivedOwner(agentResourcePaths().sharedSkills, name)) owned.push(name);
  if (!owned.length) return;
  await Promise.all([...skillReceivers(db, local, owned)].filter(([peer]) => !peerAway(peer)).map(async ([peer, cluster]) => {
    try { await signedSkillPost(db, local, peer, cluster, "/api/cluster/v2/skills/changed", {}, 4096, true); }
    catch (error) { console.warn(`Skill change notice to ${peer} failed: ${(error as Error).message}`); }
  }));
}

/** A sharing node changed a skill it shares here: fetch from that node now. */
async function ownerChanged(owner: string): Promise<{ accepted: true }> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  const cluster = requirePeer(db, local, owner);
  void askOwner(db, local, owner, cluster).then(() => writeScopedIndex(db)).catch((error) => console.warn(`Skill refresh from ${owner} failed`, error));
  return { accepted: true };
}

async function shareSkill(name: string, ids: string[], nodeIds: string[], scopes: SkillScopeGrants) {
  return withSkillMutation(async () => {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    const root = agentResourcePaths().sharedSkills;
    if (await receivedOwner(root, name)) throw failure("Received skills cannot be reshared", 403);
    if (!(await managedNames()).includes(name)) throw failure("Managed skill not found", 404);
    if (ids.length || nodeIds.length || scopes.workspaceIds.length || scopes.projectIds.length || scopes.conversations.length) await skillDigest(path.join(root, name), name);
    try { setSkillShares(db, local, name, ids, nodeIds, scopes); }
    catch (error) { throw failure((error as Error).message, 400); }
    return { name, clusterIds: skillClusterIds(db, local, name), nodeIds: skillNodeIds(db, local, name), ...skillScopeGrants(db, name) };
  });
}
async function removeSkill(name: string) {
  return withSkillMutation(async () => {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    const root = agentResourcePaths().sharedSkills, destination = path.join(root, name);
    if (!(await managedNames()).includes(name)) throw failure("Managed skill not found", 404);
    if (relayOwned(await receivedOwner(root, name))) throw failure("This skill is managed by a relay. Stop following the relay's rules to remove it.", 409);
    // A receiver may dismiss its own copy, never revoke the owner's grants.
    await suppressSkill(root, name);
    setSkillShares(db, local, name, []);
    const backup = await backupRemovedSkill(destination);
    await unlinkSkillAliases(destination, aliasRoots());
    await unmarkReceived(root, name);
    db.prepare("DELETE FROM received_skills WHERE name=?").run(name);
    noteTwinSkillRemoval(db, local, name);
    return { removed: name, backup, newConversationRequired: true };
  });
}
function route(action: (request: Request, response: HttpResponse) => Promise<unknown>, machine = false) {
  return (request: Request, response: HttpResponse, next: NextFunction) => {
    void (async () => {
      if (machine ? response.locals.machineProtocol !== 2 : !response.locals.authSession) throw failure("Forbidden", 403);
      response.json(await action(request, response));
    })().catch((error) => {
      if (error instanceof z.ZodError) { sendError(response, 400, "Invalid skill request"); return; }
      if (typeof error.status === "number") { sendError(response, error.status, error.message); return; }
      next(error);
    });
  };
}
export function registerSkillSharingRoutes(): void {
registerTwinSkillSyncRoutes();
app.get("/api/resources/skills/sharing", route(async () => localView()));
app.put("/api/resources/skills/:name/sharing", route(async (request) => {
  const selection = selectionSchema.parse(request.body);
  const result = await shareSkill(nameSchema.parse(request.params.name), selection.clusterIds, selection.nodeIds, { workspaceIds: selection.workspaceIds, projectIds: selection.projectIds, conversations: selection.conversations });
  void announceSharingChange().catch((error) => console.warn("Skill sharing notices failed", error));
  return result;
}));
app.delete("/api/resources/skills/:name", route(async (request) => {
  const result = await removeSkill(nameSchema.parse(request.params.name));
  void reconcileTwinSkills().catch((error) => console.warn(`Twin skill deletion pending: ${(error as Error).message}`));
  void announceSharingChange().catch((error) => console.warn("Skill sharing notices failed", error));
  return result;
}));
app.post("/api/resources/skills/refresh", route(async (request) => { z.object({}).strict().parse(request.body); await refreshSharedSkills(true); if (await syncRelaySkills().catch((error) => { console.warn(`Relay skill sync failed: ${(error as Error).message}`); return false; })) await (await import("./realtime.js")).reloadSharedSkills(); return localView(); }));
app.post("/api/cluster/v2/skills/manifest", route(async (request, response) => { z.object({}).strict().parse(request.body); return manifestFor(response.locals.machineNodeId); }, true));
app.post("/api/cluster/v2/skills/scoped-manifest", route(async (request, response) => { z.object({}).strict().parse(request.body); return scopedManifestFor(response.locals.machineNodeId); }, true));
app.post("/api/cluster/v2/skills/bundle", route(async (request, response) => bundleFor(response.locals.machineNodeId, z.object({ name: nameSchema }).strict().parse(request.body).name), true));
app.post("/api/cluster/v2/skills/changed", route(async (request, response) => { z.object({}).strict().parse(request.body); return ownerChanged(response.locals.machineNodeId); }, true));
}

/** For tests: what the machine routes call, without a signed request around it, and the pacing state. */
export const skillSharingForTests = {
  manifestFor, scopedManifestFor, bundleFor, ownerChanged,
  /** Forgets when each owner was asked, as after a restart. */
  forgetOwnerPaces: (): void => ownerPaces.clear(),
  /** Resolves when no sync with this owner is running or about to follow one. */
  async ownerSettled(owner: string): Promise<void> {
    for (let pace = ownerPaces.get(owner); pace?.running || pace?.following;) await (pace.following ?? pace.running);
  },
};
