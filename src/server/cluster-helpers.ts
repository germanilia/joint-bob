import { listProjectWorktrees } from "../project-worktrees.js";
import { asNode } from "../account-context.js";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type ClusterPeer, getClusterNode } from "../cluster.js";
import { getSettings, remoteTerminalAllowed, remoteTerminalSettings, runnerAccessSettings } from "../settings.js";
import { canonicalProjectId, listProjects, listWorkspaces } from "../store.js";
import { TaskWorkspaceError } from "../task-workspaces.js";
import type { ProjectRecord } from "../types.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { mayShareProject } from "./sharing-files.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";

interface PeerInventory {
  node: Awaited<ReturnType<typeof getClusterNode>>;
  syncDeviceId?: string;
  projectRoot?: string;
  projects: Array<{ project: ProjectRecord; aliases?: string[] }>;
}

/** May the authenticated machine peer see this project? Only when the project is
    shared with it through a common cluster, or it is a twin of the owner. */
export async function clusterPeerMayAccessProject(machineNodeId: string, projectId: string): Promise<boolean> {
  const id = await canonicalProjectId(projectId);
  return Boolean(id && mayShareProject(await clusterV2Database(), (await getClusterNode()).id, machineNodeId, id));
}

/** Whether a node that relays a browser to this one may open a terminal here. This node itself always may. */
export async function peerMayOpenTerminal(machineNodeId: string): Promise<boolean> {
  const local = await getClusterNode();
  if (machineNodeId === local.id) return true;
  return remoteTerminalAllowed(remoteTerminalSettings(), isTrustedTwin(await clusterV2Database(), local.id, machineNodeId));
}

/** Whether a peer may pick this node in Runs on. Its twins always may; any other node only when this node allows it. */
export async function peerMayRunHere(machineNodeId: string): Promise<boolean> {
  const local = await getClusterNode();
  if (machineNodeId === local.id) return true;
  return isTrustedTwin(await clusterV2Database(), local.id, machineNodeId) || runnerAccessSettings().otherNodes;
}

export function publicClusterPeer(peer: ClusterPeer): ClusterPeer & { online: boolean } {
  return { ...peer, online: Boolean(peer.lastSeenAt && Date.now() - Date.parse(peer.lastSeenAt) <= 90_000) };
}

/** A peer can carry a workspace this node never defined; fall back to a local one rather than inventing a folder. */
export function requirePathInsideHome(candidate: string, homeDirectory: string): void {
  const relative = path.relative(homeDirectory, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Folder must be inside this node's home directory");
}

async function localWorkspaceId(candidate: string | undefined): Promise<string> {
  const workspaces = await listWorkspaces();
  if (candidate && workspaces.some((workspace) => workspace.id === candidate)) return candidate;
  return workspaces[0]?.id ?? "personal";
}

export async function assertManagedHomeChangeAllowed(nextHomePath: string): Promise<void> {
  const currentHomePath = getSettings().projects.homePath;
  if (path.resolve(currentHomePath) === path.resolve(nextHomePath)) return;
  for (const project of await asNode(() => listProjects())) {
    if ((await listProjectWorktrees(project.id)).length) {
      throw new TaskWorkspaceError("Merge and delete worktrees before changing the Joint Bob home folder");
    }
  }
}

export async function mappedPathInsideHome(candidate: string): Promise<string> {
  const homeDirectory = await realpath(os.homedir());
  const resolved = path.resolve(candidate);
  let existing = resolved;
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  requirePathInsideHome(existing, homeDirectory);
  return resolved;
}

