import { randomUUID } from "node:crypto";
import { activeAllocationAttempt, modelAllocationStore } from "./model-allocation.js";
import { withProjectRuntime } from "../project-runtime.js";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { recordConversationStart } from "../conversation-starts.js";
import { ensureConversationRecord } from "../conversation-records.js";
import { githubAccountFor } from "../github-credentials.js";
import { ensureSessionTitle, setSessionDone } from "../names.js";
import { integrateProjectWorktree, integrationStatus, hasVerifiedIntegration } from "../worktree-integration.js";
import {
  createProjectWorktree, deleteProjectWorktree, getProjectWorktree, listProjectWorktrees, ProjectWorktreeError,
  readWorktreeMergedPullRequest, readWorktreePullRequestSnapshot, recordWorktreeMergedPullRequest,
  recordWorktreePullRequest, saveWorktreePullRequestSnapshot, withoutGitIgnored, worktreeChanges,
  worktreeConversationIndex, type ProjectWorktree, type WorktreePullRequest,
} from "../project-worktrees.js";
import { conversationLeaseRunning } from "../conversation-runtime.js";
import { conversationScopeId, genericSecretEnvironment, getScopeSecretAccounts, githubAccountsForProject, persistConversationSecretAccounts } from "../secrets.js";
import { getProject } from "../store.js";
import { isHarnessId, PROJECT_COLORS, type ProjectRecord } from "../types.js";
import type { WorktreeAgentIdentity } from "../worktree-agent.js";
import { rebaseWorktreeChanges, reconcileWorktreeMain, type MergedWorktreeBase } from "../worktree-git.js";
import { queueConversationPrompt } from "./conversation-prompt.js";
import { inspectWorktreePullRequest, openWorktreePullRequest, type MergedPullRequestRef } from "./github-pull-request.js";
import { findHarnessSession, harnessSessionBusy } from "./harness-sessions.js";
import { assertProjectEditable } from "./projects.js";
import { broadcastToProject } from "./realtime.js";
import { scheduleWorktreeRetirement } from "./worktree-retirement.js";

const worktreeId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const worktreeAgentRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list") }).strict(),
  z.object({ operation: z.literal("reconcile-main"), worktreeId: worktreeId.optional() }).strict(),
  z.object({ operation: z.literal("status"), operationId: worktreeId }).strict(),
  z.object({ operation: z.literal("merge"), worktreeId: worktreeId.optional(), operationId: worktreeId, title: z.string().trim().min(1).max(256), check: z.string().trim().min(1).max(10_000), resolutionTarget: z.string().regex(/^[a-f0-9]{40}$/).optional() }).strict(),
  z.object({ operation: z.literal("create"), name: z.string().max(200), color: z.enum(PROJECT_COLORS).optional(), finish: z.enum(["local", "pr"]).optional() }).strict(),
  z.object({ operation: z.literal("start"), worktreeId, prompt: z.string().trim().min(1).max(100_000), title: z.string().trim().min(1).max(120).optional() }).strict(),
  z.object({ operation: z.literal("pr"), worktreeId: worktreeId.optional(), title: z.string().trim().min(1).max(256), body: z.string().max(60_000).default(""), base: z.string().trim().min(1).max(200).optional(), merge: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal("delete"), worktreeId }).strict(),
]);
export type WorktreeAgentRequest = z.infer<typeof worktreeAgentRequestSchema>;

/** Worktrees whose conversation marker names the caller, by harness session or logical conversation. */
async function callerWorktree(identity: WorktreeAgentIdentity, projectId: string): Promise<ProjectWorktree | undefined> {
  const index = await worktreeConversationIndex(projectId);
  return index.get(`${identity.engine}:${identity.sessionId}`) ?? index.get(`${identity.engine}:${identity.conversationId}`);
}

/** Conversations started in the worktree whose turn or background work is still running, here or on a peer. */
async function runningConversations(projectId: string, worktree: ProjectWorktree): Promise<string[]> {
  const running: string[] = [];
  for (const [key, candidate] of await worktreeConversationIndex(projectId)) {
    if (candidate.id !== worktree.id) continue;
    const [engine, sessionId] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (!isHarnessId(engine)) continue;
    const local = findHarnessSession(projectId, engine, sessionId);
    if ((local && harnessSessionBusy(local)) || conversationLeaseRunning(engine, sessionId)) running.push(sessionId);
  }
  return running;
}

function createdByCaller(worktree: ProjectWorktree, identity: WorktreeAgentIdentity): boolean {
  return worktree.createdBy?.engine === identity.engine && [identity.conversationId, identity.sessionId].includes(worktree.createdBy.conversationId);
}

async function localWorktree(projectId: string, id: string): Promise<ProjectWorktree> {
  const worktree = await getProjectWorktree(projectId, id);
  if (!worktree) throw new ProjectWorktreeError(404, "Worktree not found on this node");
  return worktree;
}

export function pullRequestBranch(worktree: Pick<ProjectWorktree, "id" | "name">): string {
  const slug = worktree.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "worktree";
  return `joint-bob/${slug}-${worktree.id.slice(0, 8)}`;
}

async function startConversation(identity: WorktreeAgentIdentity, project: ProjectRecord, worktree: ProjectWorktree, prompt: string, title?: string) {
  const sessionId = randomUUID();
  await ensureConversationRecord(project.id, identity.engine, sessionId, (await getClusterNode()).id);
  await ensureSessionTitle(sessionId, title ?? worktree.name);
  // Workspace and project accounts already apply: the conversation stays in this project.
  // Accounts attached to the calling conversation itself are copied over.
  const { accountIds } = await getScopeSecretAccounts("conversation", conversationScopeId(identity.engine, identity.sessionId));
  await persistConversationSecretAccounts(identity.engine, sessionId, accountIds);
  try {
    await queueConversationPrompt({ projectId: project.id, engine: identity.engine, sessionId, message: prompt, requestId: randomUUID(), label: "Worktree", worktreeId: worktree.id, until: "started" });
  } catch (error) {
    throw new ProjectWorktreeError(502, `Conversation ${sessionId} did not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Kept so what a run started can be followed: Bob settles a webhook's alert by how the conversation it started ended.
  recordConversationStart(await clusterV2Database(), {
    projectId: project.id, parentSessionId: identity.sessionId, parentConversationId: identity.conversationId, childSessionId: sessionId,
    engine: identity.engine, worktreeId: worktree.id, startedAt: new Date().toISOString(),
  });
  broadcastToProject(project.id, { type: "sessionsChanged" });
  return { conversationId: sessionId, engine: identity.engine, worktreeId: worktree.id, secretAccounts: accountIds.length };
}

async function loadMergedBase(projectId: string, worktreeId: string, ref: MergedPullRequestRef): Promise<MergedWorktreeBase> {
  const snapshot = await readWorktreePullRequestSnapshot(projectId, worktreeId, ref.pullRequest.snapshotFile);
  return {
    ...(snapshot ? { snapshot: { writes: snapshot.writes, deletes: snapshot.deletes } } : {}),
    pullRequest: {
      number: ref.pullRequest.number,
      baseCommit: ref.pullRequest.baseCommit,
      headCommit: ref.headCommit ?? ref.pullRequest.headCommit,
    },
    mergedCommit: ref.mergedCommit ?? ref.pullRequest.mergedCommit,
  };
}

function githubCredentialsFor(projectId: string, identity: WorktreeAgentIdentity) {
  const conversation = { engine: identity.engine, sessionId: identity.sessionId };
  const accounts = githubAccountsForProject(projectId, conversation);
  const gitEnvironment = genericSecretEnvironment(projectId, conversation);
  const fallback = gitEnvironment.GH_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  return {
    gitEnvironment,
    credentials: {
      tokenFor: (repository: { owner: string; host: string }) => githubAccountFor(accounts, repository)?.token ?? fallback,
      sshHosts: accounts.filter((account) => account.sshKey).map((account) => account.sshHost),
    },
  };
}

async function openPullRequest(identity: WorktreeAgentIdentity, project: ProjectRecord, worktree: ProjectWorktree, input: { title: string; body: string; base?: string; merge?: boolean }) {
  const { gitEnvironment, credentials } = githubCredentialsFor(project.id, identity);
  const changes = await withoutGitIgnored(project.path, await worktreeChanges(project.id, worktree.id));
  const mergedPrevious = await readWorktreeMergedPullRequest(project.id, worktree.id);
  let published: { headCommit: string; mergedCommit?: string } | undefined;
  const result = await openWorktreePullRequest({
    projectPath: project.path, branchName: pullRequestBranch(worktree), title: input.title, body: input.body, base: input.base, merge: input.merge,
    changes, previous: worktree.pullRequest, mergedPrevious,
    rebase: async (base, merged) => rebaseWorktreeChanges(project.path, gitEnvironment, changes, base, merged ? await loadMergedBase(project.id, worktree.id, merged) : undefined),
    onMergedPrevious: async (merged) => {
      const updated: WorktreePullRequest = {
        ...merged.pullRequest,
        ...(merged.headCommit ? { headCommit: merged.headCommit } : {}),
        ...(merged.mergedCommit ? { mergedCommit: merged.mergedCommit } : {}),
      };
      await recordWorktreeMergedPullRequest(project.id, worktree.id, updated);
    },
    onPublished: (info) => { published = { headCommit: info.headCommit, mergedCommit: info.mergedCommit }; },
  }, credentials);
  const snapshotFile = await saveWorktreePullRequestSnapshot(project.id, worktree.id, result.pullRequest.number, changes);
  const recorded: WorktreePullRequest = {
    ...result.pullRequest,
    ...(published?.headCommit ? { headCommit: published.headCommit } : {}),
    ...(published?.mergedCommit ? { mergedCommit: published.mergedCommit } : {}),
    snapshotFile,
  };
  await recordWorktreePullRequest(project.id, worktree.id, recorded, undefined, { merged: Boolean(result.merged) });
  broadcastToProject(project.id, { type: "worktreesChanged" });
  if (result.mergeError) throw new ProjectWorktreeError(409, `Pull request ${result.pullRequest.url} is open, but GitHub did not merge it: ${result.mergeError}. Tell the user, with the pull request link.`);
  return { worktreeId: worktree.id, ...result };
}

export async function worktreeAgentRequest(identity: WorktreeAgentIdentity, request: WorktreeAgentRequest): Promise<unknown> {
  const project = await getProject(identity.projectId);
  if (!project) throw new ProjectWorktreeError(404, "Project not found");
  const current = await callerWorktree(identity, project.id);
  switch (request.operation) {
    case "list": {
      const worktrees = await listProjectWorktrees(project.id);
      return {
        worktrees: worktrees.map((worktree) => ({
          id: worktree.id, name: worktree.name, path: worktree.path, createdAt: worktree.createdAt, lastMergedAt: worktree.lastMergedAt,
          pullRequest: worktree.pullRequest, current: worktree.id === current?.id, createdByThisConversation: createdByCaller(worktree, identity),
        })),
      };
    }
    case "create": {
      await assertProjectEditable(project);
      const worktree = await createProjectWorktree(project, {
        name: request.name, color: request.color, localMain: request.finish !== "pr", createdBy: { engine: identity.engine, conversationId: identity.conversationId },
        gitEnvironment: genericSecretEnvironment(project.id, { engine: identity.engine, sessionId: identity.sessionId }),
      });
      broadcastToProject(project.id, { type: "worktreesChanged" });
      return { worktree: { id: worktree.id, name: worktree.name, path: worktree.path, color: worktree.color } };
    }
    case "start": {
      await assertProjectEditable(project);
      return startConversation(identity, project, await localWorktree(project.id, request.worktreeId), request.prompt, request.title);
    }
    case "status": {
      const status = integrationStatus(project.id, request.operationId, identity.conversationId);
      if (!status) throw new ProjectWorktreeError(404, "Integration operation not found for this conversation");
      return status;
    }
    case "reconcile-main": {
      await assertProjectEditable(project);
      const id = request.worktreeId ?? current?.id;
      if (!id) throw new ProjectWorktreeError(400, "Pass --worktree ID or run in a worktree");
      const worktree = await localWorktree(project.id, id);
      if (worktree.id !== current?.id && !createdByCaller(worktree, identity)) throw new ProjectWorktreeError(403, "Only this worktree's conversation or creator may reconcile main");
      const changes = await worktreeChanges(project.id, id);
      if (!changes.gitBase) throw new ProjectWorktreeError(409, "Worktree has no Git base");
      return withProjectRuntime(project.id, () => reconcileWorktreeMain(project.path,
        genericSecretEnvironment(project.id, { engine: identity.engine, sessionId: identity.sessionId }), changes.gitBase!));
    }
    case "merge": {
      await assertProjectEditable(project);
      const previous = integrationStatus(project.id, request.operationId, identity.conversationId);
      const id = request.worktreeId ?? current?.id ?? previous?.worktreeId;
      if (!id) throw new ProjectWorktreeError(400, "This conversation does not run in a worktree; pass --worktree ID");
      let mergedBase: MergedWorktreeBase | undefined;
      if (!previous) {
        const worktree = await localWorktree(project.id, id);
        if (worktree.id !== current?.id && !createdByCaller(worktree, identity)) throw new ProjectWorktreeError(403, "Only this worktree's conversation or creator may integrate it");
        let mergedPullRequest = await readWorktreeMergedPullRequest(project.id, worktree.id);
        if (worktree.pullRequest && mergedPullRequest?.number !== worktree.pullRequest.number) {
          const { credentials } = githubCredentialsFor(project.id, identity);
          let status: Awaited<ReturnType<typeof inspectWorktreePullRequest>>;
          try {
            status = await inspectWorktreePullRequest(project.path, worktree.pullRequest, credentials);
          } catch {
            throw new ProjectWorktreeError(409, `Pull request #${worktree.pullRequest.number} (${worktree.pullRequest.url}) is recorded for this worktree and its status could not be checked on GitHub; finish with pr --merge instead of merging locally`);
          }
          if (status.state === "open") {
            throw new ProjectWorktreeError(409, `Pull request #${worktree.pullRequest.number} (${worktree.pullRequest.url}) is still open for this worktree; update or merge it with pr --merge instead of merging locally`);
          }
          if (status.merged) {
            const updated: WorktreePullRequest = {
              ...worktree.pullRequest,
              ...(status.headCommit ? { headCommit: status.headCommit } : {}),
              ...(status.mergedCommit ? { mergedCommit: status.mergedCommit } : {}),
            };
            await recordWorktreeMergedPullRequest(project.id, worktree.id, updated);
            mergedPullRequest = updated;
          }
        }
        if (mergedPullRequest && mergedPullRequest.base === "main") {
          mergedBase = await loadMergedBase(project.id, worktree.id, {
            pullRequest: mergedPullRequest,
            headCommit: mergedPullRequest.headCommit,
            mergedCommit: mergedPullRequest.mergedCommit,
          });
        }
        const running = (await runningConversations(project.id, worktree)).filter(sessionId => ![identity.sessionId, identity.conversationId].includes(sessionId));
        if (running.length) throw new ProjectWorktreeError(409, `Worktree has other running conversations: ${running.join(", ")}`);
      }
      const allocation = integrationStatus(project.id, request.operationId, identity.conversationId) ? undefined : activeAllocationAttempt(project.id, identity.conversationId);
      const result = await withProjectRuntime(project.id, () => integrateProjectWorktree(project, id, { ...request, ownerId: identity.conversationId, deferCleanup: id === current?.id, mergedBase }, undefined,
        genericSecretEnvironment(project.id, { engine: identity.engine, sessionId: identity.sessionId })));
      if (allocation) modelAllocationStore().verifyAttempt(allocation.ownerId, project.id, identity.conversationId, request.operationId, result.status, allocation.attempt.attemptId);
      if (result.status === "committed" && id === current?.id) {
        await setSessionDone(identity.conversationId, true);
        scheduleWorktreeRetirement(project);
      }
      broadcastToProject(project.id, { type: "worktreesChanged" });
      broadcastToProject(project.id, { type: "sessionsChanged" });
      return result;
    }
    case "pr": {
      const id = request.worktreeId ?? current?.id;
      if (id && hasVerifiedIntegration(project.id, id)) throw new ProjectWorktreeError(409, "This worktree was already integrated locally; no PR will be published");
      if (!request.worktreeId && !current) throw new ProjectWorktreeError(400, "This conversation does not run in a worktree; pass --worktree ID");
      return openPullRequest(identity, project, request.worktreeId ? await localWorktree(project.id, request.worktreeId) : current!, request);
    }
    case "delete": {
      await assertProjectEditable(project);
      const worktree = await localWorktree(project.id, request.worktreeId);
      if (worktree.id === current?.id) throw new ProjectWorktreeError(409, "A conversation cannot delete the worktree it runs in");
      if (!createdByCaller(worktree, identity)) throw new ProjectWorktreeError(403, "Only the conversation that created this worktree may delete it; ask the user");
      const running = await runningConversations(project.id, worktree);
      if (running.length) throw new ProjectWorktreeError(409, `Conversation ${running.join(", ")} is still running in this worktree; let it finish with pr, then delete`);
      await deleteProjectWorktree(project.id, worktree.id);
      broadcastToProject(project.id, { type: "worktreesChanged" });
      broadcastToProject(project.id, { type: "sessionsChanged" });
      return { deleted: worktree.id };
    }
  }
}
