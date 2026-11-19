import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { getSharingCluster, listSharingMemberships } from "../cluster-sharing-policy.js";
import { listTwinRelationships } from "../cluster-twins.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { relayRuntimeInstance, startRelay } from "../relay/index.js";
import { normalizeRelayOrigin } from "../relay/protocol.js";
import { parseEnrollLink, type RelayRuntime } from "../relay/runtime.js";
import { membershipByOrigin, type RelayMembership } from "../relay/store.js";
import { listTwinUpdateTargets } from "../twin-updates.js";
import { localMembershipDescriptor, parseV2InvitationLink } from "./cluster-v2.js";
import { isClusterOriginUrl } from "./http-auth.js";
import { signedPeerPost } from "./replication-v2.js";
import { acceptTwinHttpLink, createTwinHttpInvitation, parseTwinLink } from "./twins.js";

/**
 * One link that sets up a machine. It bundles what used to be pasted one by one, in an order
 * nothing explained: a pass for each relay the issuing machine can be reached on, a twin
 * invitation from the issuer and from each of its twins (for the owner's own machine), and an
 * invitation to each chosen cluster. Every part is the ordinary one-time link of its kind and
 * is checked the ordinary way when it is used; the bundle adds no trust of its own.
 */

const PREFIX = "machine-v1";
/** The twin and cluster invitations inside expire after this long, so the bundle does too. */
export const MACHINE_LINK_TTL_MS = 15 * 60 * 1000;

const text = z.string().trim().min(1).max(120);
const part = z.string().min(1).max(8192);
const bundleSchema = z.object({
  version: z.literal(1),
  issuer: z.object({ nodeId: z.string().uuid(), name: text }).strict(),
  /** The owner's own machine (twins) or someone else's (clusters only). */
  own: z.boolean(),
  expiresAt: z.number().int().positive(),
  relays: z.array(z.object({ origin: z.string().max(500), link: part.nullable() }).strict()).max(8),
  twins: z.array(z.object({ name: text, link: part }).strict()).max(16),
  clusters: z.array(z.object({ name: text, link: part }).strict()).max(16),
}).strict();
export type MachineLinkBundle = z.infer<typeof bundleSchema>;

export interface MachineLinkSummary {
  issuer: string;
  own: boolean;
  expiresAt: number;
  relays: Array<{ origin: string; pass: boolean }>;
  twins: string[];
  clusters: string[];
}

export type MachineLinkStepStatus = "done" | "failed" | "waiting";
export interface MachineLinkStep { kind: "relay" | "twin" | "cluster"; title: string; status: MachineLinkStepStatus; detail: string }

export function isMachineLink(link: unknown): boolean {
  if (typeof link !== "string") return false;
  try { return new URL(link.trim()).hash.startsWith(`#${PREFIX}.`); } catch { return false; }
}

export function parseMachineLink(link: unknown): MachineLinkBundle {
  const invalid = (): never => { throw new ClusterV2HttpError(400, "This is not a link for adding a machine"); };
  if (typeof link !== "string" || link.length > 65536) return invalid();
  let url: URL;
  try { url = new URL(link.trim()); } catch { return invalid(); }
  const [prefix, encoded, ...rest] = url.hash.slice(1).split(".");
  if (!isClusterOriginUrl(url.origin) || url.pathname !== "/join" || url.search || prefix !== PREFIX || rest.length || !/^[A-Za-z0-9_-]+$/.test(encoded ?? "")) return invalid();
  let bundle: MachineLinkBundle;
  try { bundle = bundleSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))); } catch { return invalid(); }
  for (const relay of bundle.relays) {
    try { if (normalizeRelayOrigin(relay.origin) !== relay.origin || (relay.link && parseEnrollLink(relay.link).origin !== relay.origin)) return invalid(); }
    catch { return invalid(); }
  }
  return bundle;
}

export function summarizeMachineLink(bundle: MachineLinkBundle): MachineLinkSummary {
  return {
    issuer: bundle.issuer.name, own: bundle.own, expiresAt: bundle.expiresAt,
    relays: bundle.relays.map((relay) => ({ origin: relay.origin, pass: Boolean(relay.link) })),
    twins: bundle.twins.map((twin) => twin.name), clusters: bundle.clusters.map((cluster) => cluster.name),
  };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * Builds the link on a machine that is already set up. A relay that gives no pass, or a twin
 * that cannot be asked right now, is left out and named in `notes`, so the person knows what
 * the new machine will still have to do by hand.
 */
export async function createMachineLink(input: { own: boolean; clusterIds: string[]; issueClusterInvitation: (clusterId: string, expectedEpoch: number) => Promise<string> }): Promise<{ link: string; summary: MachineLinkSummary; notes: string[] }> {
  await startRelay();
  const local = await localMembershipDescriptor(), db = await clusterV2Database();
  const notes: string[] = [];
  const bundle: MachineLinkBundle = { version: 1, issuer: { nodeId: local.nodeId, name: local.name.slice(0, 120) }, own: input.own, expiresAt: Date.now() + MACHINE_LINK_TTL_MS, relays: [], twins: [], clusters: [] };

  for (const pass of await relayRuntimeInstance()?.invitePasses() ?? []) {
    bundle.relays.push({ origin: pass.origin, link: pass.link });
    if (!pass.link) notes.push(`${new URL(pass.origin).host} gave no pass (${pass.note ?? "it runs an older Joint Bob"}); the new machine will ask its operator for access.`);
  }

  if (input.own) {
    bundle.twins.push({ name: bundle.issuer.name, link: (await createTwinHttpInvitation()).link });
    // Each of this machine's twins issues its own invitation, because this machine asks: the
    // new machine then becomes a twin of all of them with nothing to approve on each.
    for (const twin of listTwinUpdateTargets(db, local.nodeId)) {
      try {
        const answer = z.object({ link: part }).parse(await signedPeerPost(twin, "/api/cluster/v2/twins/vouch", { relationshipId: twin.relationshipId }));
        if (parseTwinLink(answer.link).invitation.body.inviter.nodeId !== twin.nodeId) throw new Error("it answered for another machine");
        bundle.twins.push({ name: twin.name.slice(0, 120), link: answer.link });
      } catch (error) {
        notes.push(`${twin.name} could not be asked (${message(error)}); pair it with the new machine later from Settings › Cluster.`);
      }
    }
  }

  const memberships = new Set(listSharingMemberships(db, local.nodeId).map((item) => item.clusterId));
  for (const clusterId of [...new Set(input.clusterIds)]) {
    if (!memberships.has(clusterId)) throw new ClusterV2HttpError(404, "Not found");
    const cluster = getSharingCluster(db, clusterId);
    try { bundle.clusters.push({ name: cluster.name.slice(0, 120), link: await input.issueClusterInvitation(clusterId, cluster.managerEpoch) }); }
    catch (error) { notes.push(`${cluster.name} gave no invitation (${message(error)}).`); }
  }

  if (!bundle.twins.length && !bundle.clusters.length) throw new ClusterV2HttpError(409, "Choose your own machine, or at least one cluster to join");
  return { link: `${local.url}/join#${PREFIX}.${Buffer.from(JSON.stringify(bundle)).toString("base64url")}`, summary: summarizeMachineLink(bundle), notes };
}

/** Resolves once the relay admits this machine, refuses it, or the wait runs out. */
function relayAnswer(runtime: RelayRuntime, origin: string, timeoutMs: number): Promise<RelayMembership | undefined> {
  const read = (): RelayMembership | undefined => membershipByOrigin(runtime.db, origin);
  const settled = (item: RelayMembership | undefined): boolean => !item || ["admitted", "pending", "denied", "revoked", "suspended"].includes(item.status);
  return new Promise((resolve) => {
    const finish = (): void => { clearTimeout(timer); runtime.off("changed", check); resolve(read()); };
    const check = (): void => { if (settled(read())) finish(); };
    const timer = setTimeout(finish, timeoutMs);
    runtime.on("changed", check);
    check();
  });
}

async function joinRelay(runtime: RelayRuntime, relay: MachineLinkBundle["relays"][number]): Promise<MachineLinkStep> {
  const host = new URL(relay.origin).host, step = (status: MachineLinkStepStatus, detail: string): MachineLinkStep => ({ kind: "relay", title: `Relay ${host}`, status, detail });
  try {
    const existing = membershipByOrigin(runtime.db, relay.origin);
    if (existing?.status === "admitted") return step("done", "This machine is already on it.");
    if (relay.link) runtime.addWithToken(relay.link); else runtime.requestAccess(relay.origin);
    const answer = await relayAnswer(runtime, relay.origin, 20_000);
    if (answer?.status === "admitted") return step("done", relay.link ? "Joined with the pass in the link." : "Joined.");
    if (answer?.status === "pending") return step("waiting", `Waiting for the relay's operator to approve this machine${answer.pairingCode ? ` (code ${answer.pairingCode})` : ""}. Use the link again afterwards.`);
    return step("failed", answer?.lastError || "The relay did not answer.");
  } catch (error) {
    return step("failed", message(error));
  }
}

/** A peer reached through a relay this machine joined a moment ago may not be listed there yet. */
async function withRetry<T>(action: () => Promise<T>, attempts = 6, pauseMs = 2_500): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await action(); }
    catch (error) {
      const unavailable = error instanceof ClusterV2HttpError && error.statusCode === 503;
      if (!unavailable || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
}

/**
 * Does what the link says on the machine being set up, in the one order that works: relays
 * first (they are the route to everything else), then twins, then clusters. Each step reports
 * on its own, and a failed step never undoes the ones before it.
 */
export async function useMachineLink(link: unknown, joinCluster: (link: string, requestId: string) => Promise<unknown>): Promise<{ summary: MachineLinkSummary; steps: MachineLinkStep[] }> {
  const bundle = parseMachineLink(link);
  if (Date.now() > bundle.expiresAt) throw new ClusterV2HttpError(410, "This link has expired. Create a new one on the other machine.");
  const local = await getClusterNode(), db = await clusterV2Database();
  if (bundle.issuer.nodeId === local.id) throw new ClusterV2HttpError(409, "This link was made on this machine. Paste it on the machine you are adding.");
  await startRelay();
  const steps: MachineLinkStep[] = [];

  const runtime = relayRuntimeInstance();
  for (const relay of bundle.relays) {
    if (!runtime) { steps.push({ kind: "relay", title: `Relay ${new URL(relay.origin).host}`, status: "failed", detail: "Relays are still starting; try again in a moment." }); continue; }
    steps.push(await joinRelay(runtime, relay));
  }

  for (const twin of bundle.twins) {
    const step = (status: MachineLinkStepStatus, detail: string): void => { steps.push({ kind: "twin", title: `Twin of ${twin.name}`, status, detail }); };
    try {
      const inviter = parseTwinLink(twin.link).invitation.body.inviter.nodeId;
      if (listTwinRelationships(db, local.id).some((item) => item.status === "active" && item.peer.nodeId === inviter)) { step("done", "Already your twin."); continue; }
      await withRetry(() => acceptTwinHttpLink(twin.link));
      step("done", "Everything you own is now shared between the two machines.");
    } catch (error) {
      step("failed", reason(message(error)));
    }
  }

  for (const cluster of bundle.clusters) {
    const step = (status: MachineLinkStepStatus, detail: string): void => { steps.push({ kind: "cluster", title: `Cluster ${cluster.name}`, status, detail }); };
    try {
      parseV2InvitationLink(cluster.link);
      await withRetry(() => joinCluster(cluster.link, randomUUID()));
      step("done", "Joined. It shares nothing with the cluster until you choose projects.");
    } catch (error) {
      step("failed", reason(message(error)));
    }
  }
  return { summary: summarizeMachineLink(bundle), steps };
}

/** The handshake errors are terse; these say what to do about the common ones. */
function reason(text: string): string {
  if (/unavailable/i.test(text)) return "The other machine did not answer. Check that it is on, then use the link again.";
  if (/expired/i.test(text)) return "This part of the link has expired. Create a new link on the other machine.";
  if (/Set this machine's HTTPS URL or join a relay/i.test(text)) return "This machine has no way to be reached yet: join a relay or set its HTTPS address first.";
  return text;
}
