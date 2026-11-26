// Team automations & scheduled tasks: any team agent may propose an automation or scheduled task,
// and the team Chief (coordinator) approves or rejects it. Approved requests create real live
// Joint Bob automations/schedules scoped to the target team member on this host node.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { asNode } from '../account-context.js';
import { getClusterNode } from '../cluster.js';
import { clusterV2Database } from '../cluster-v2-store.js';
import { getPersonalAssistantById, type PersonalAssistant } from '../personal-assistants.js';
import { describeSchedule } from '../control-center/automations.js';
import { scheduleSchema } from '../schedule.js';
import { broadcastToProject } from '../server/realtime.js';
import { createAutomation, listWebhooks, webhookInputSchema, type Webhook } from '../webhooks.js';
import { getTeam, getTeamAssignment, listTeamAgents, TEAM_ROLE_PATTERN, teamCoordinator, teamDatabase, teamRolesSync, TeamError, type TeamRole } from './store.js';
import { listNodeAttachableSecrets } from './proposals.js';
import { teamAssignmentDestination } from './runtime.js';
import { getPersonalAssistantTurn } from '../personal-assistants.js';
import { runningPromptRequestId } from '../assistant-collaboration/bridge-tools.js';

const roleSchema = z.string().regex(TEAM_ROLE_PATTERN);

export const teamAutomationRequestInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  trigger: z.enum(['schedule', 'webhook']),
  targetRole: roleSchema.optional(),
  instructions: z.string().trim().min(1).max(50_000),
  schedule: scheduleSchema.nullable().optional(),
  rationale: z.string().trim().min(1).max(2000),
  enabled: z.boolean().default(true),
  pauseOnFailure: z.boolean().default(false),
  secretAccountIds: z.array(z.string().uuid()).max(20).default([]),
}).strict().superRefine((input, ctx) => {
  if (input.trigger === 'schedule' && !input.schedule) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['schedule'], message: 'Scheduled tasks require a schedule' });
  }
  if (input.trigger === 'webhook' && input.schedule) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['schedule'], message: 'Webhook automations must not include a schedule' });
  }
});

export type TeamAutomationRequestInput = z.infer<typeof teamAutomationRequestInputSchema>;
export type TeamAutomationRequestState = 'pending_chief' | 'approved' | 'rejected' | 'failed';

export interface TeamAutomationRequest {
  id: string;
  teamId: string;
  assignmentId: string;
  rootId: string;
  requestedByRole: TeamRole;
  targetRole: TeamRole;
  name: string;
  trigger: 'schedule' | 'webhook';
  instructions: string;
  schedule: TeamAutomationRequestInput['schedule'];
  scheduleSummary: string | null;
  rationale: string;
  enabled: boolean;
  pauseOnFailure: boolean;
  secretAccountIds: string[];
  state: TeamAutomationRequestState;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  automationId?: string;
  error?: string;
}

export async function teamAutomationDatabase(): Promise<DatabaseSync> {
  const db = await teamDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_team_automation_requests (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    requested_by_role TEXT NOT NULL,
    state TEXT NOT NULL,
    record TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS assistant_team_automation_requests_team ON assistant_team_automation_requests(team_id, state);
  CREATE INDEX IF NOT EXISTS assistant_team_automation_requests_root ON assistant_team_automation_requests(team_id, root_id, state);`);
  return db;
}

/** Verifies any live team member (specialist or coordinator) is actively executing this assignment. */
async function requireLiveTeamAgent(assignmentId: string) {
  const assignment = await getTeamAssignment(assignmentId);
  if (!assignment) throw new TeamError('Live team member turn required', 403);
  const resolved = await teamAssignmentDestination(assignment);
  const turn = await getPersonalAssistantTurn(resolved.profile.accountId, resolved.profile.id, assignment.requestId);
  if (!turn || turn.status !== 'running' || runningPromptRequestId(resolved.team.projectId, resolved.destination.sessionId) !== assignment.requestId) {
    throw new TeamError('Live team member turn required', 403);
  }
  return resolved;
}

async function resolveTargetMember(teamId: string, role: string): Promise<{ role: TeamRole; profile: PersonalAssistant }> {
  const member = (await listTeamAgents(teamId)).find(m => m.role === role);
  if (!member) throw new TeamError(`Unknown team role: ${role}`, 404);
  const profile = await getPersonalAssistantById(member.assistantId);
  if (!profile) throw new TeamError(`Assistant for role /${role} no longer exists`, 404);
  return { role: member.role, profile };
}

async function instantiateTeamAutomation(teamId: string, req: TeamAutomationRequest): Promise<{ webhook: Webhook; secret: string | null }> {
  const team = await getTeam(teamId);
  const { profile } = await resolveTargetMember(teamId, req.targetRole);
  const local = await getClusterNode();
  const parsed = webhookInputSchema.parse({
    creatorAccountId: profile.accountId,
    name: req.name,
    target: { kind: 'assistant', projectId: profile.projectId, assistantId: profile.id },
    secretAccountIds: req.secretAccountIds,
    model: null,
    reasoning: null,
    context: req.instructions,
    enabled: req.enabled,
    trigger: req.trigger,
    schedule: req.trigger === 'schedule' ? req.schedule : null,
    pauseOnFailure: req.pauseOnFailure,
    runInWorktree: false,
    preserveFiles: false,
  });
  const db = await clusterV2Database();
  const created = await asNode(() => createAutomation(db, parsed, { ownerNodeId: local.id }));
  broadcastToProject(profile.projectId, { type: 'automationsChanged' });
  if (profile.projectId !== team.projectId) broadcastToProject(team.projectId, { type: 'automationsChanged' });
  return created;
}

export async function listTeamAutomationRequests(teamId: string, limit = 50): Promise<TeamAutomationRequest[]> {
  const db = await teamAutomationDatabase();
  const rows = db.prepare('SELECT state, record FROM assistant_team_automation_requests WHERE team_id=? ORDER BY rowid DESC LIMIT ?')
    .all(teamId, Math.max(1, Math.min(limit, 200))) as Array<{ state: TeamAutomationRequestState; record: string }>;
  return rows.map(row => ({ ...JSON.parse(row.record) as TeamAutomationRequest, state: row.state }));
}

export async function listPendingAutomationRequestsForRoot(teamId: string, rootId: string): Promise<TeamAutomationRequest[]> {
  const db = await teamAutomationDatabase();
  const rows = db.prepare("SELECT state, record FROM assistant_team_automation_requests WHERE team_id=? AND root_id=? AND state='pending_chief' ORDER BY rowid")
    .all(teamId, rootId) as Array<{ state: TeamAutomationRequestState; record: string }>;
  return rows.map(row => ({ ...JSON.parse(row.record) as TeamAutomationRequest, state: row.state }));
}

/** Lists both live automations/schedules targeting this team's members/project and pending/recent requests. */
export async function listTeamAutomations(teamId: string, limit = 50) {
  const team = await getTeam(teamId);
  const members = await listTeamAgents(teamId);
  const roleByAssistantId = new Map(members.map(m => [m.assistantId, m.role]));
  const db = await clusterV2Database();
  const allWebhooks = listWebhooks(db).filter(hook =>
    !hook.reply && (
      hook.target.projectId === team.projectId
      || (hook.target.kind === 'assistant' && roleByAssistantId.has(hook.target.assistantId))
    ),
  );
  const automations = allWebhooks.map(hook => ({
    id: hook.id,
    name: hook.name,
    trigger: hook.trigger,
    targetRole: hook.target.kind === 'assistant' ? (roleByAssistantId.get(hook.target.assistantId) ?? null) : null,
    enabled: hook.enabled,
    schedule: hook.schedule,
    scheduleSummary: hook.schedule ? describeSchedule(hook.schedule) : null,
    nextRun: hook.nextRun,
    instructions: hook.context,
    createdAt: hook.createdAt,
  }));
  const requests = await listTeamAutomationRequests(teamId, limit);
  return { automations, requests };
}

/**
 * Any live team agent may propose an automation or scheduled task.
 * - Specialists create a `pending_chief` request that the Chief reviews and approves/rejects.
 * - The Chief itself can create & approve directly (since Chief is the approver).
 */
export async function requestTeamAutomation(assignmentId: string, rawInput: unknown): Promise<{
  request: TeamAutomationRequest;
  automation?: { id: string; trigger: 'schedule' | 'webhook'; nextRun: number | null };
}> {
  const input = teamAutomationRequestInputSchema.parse(rawInput);
  const { team, assignment } = await requireLiveTeamAgent(assignmentId);
  const targetRole = input.targetRole ?? assignment.role;
  await resolveTargetMember(team.id, targetRole);
  if (input.secretAccountIds.length) {
    const usable = new Set((await listNodeAttachableSecrets(team.id)).map(s => s.id));
    for (const secretId of input.secretAccountIds) {
      if (!usable.has(secretId)) throw new TeamError(`Secret ${secretId} is not available in this team's attachable pool`, 403);
    }
  }
  const coordinator = await teamCoordinator(team);
  const isChief = assignment.role === coordinator;
  const now = new Date().toISOString();
  const req: TeamAutomationRequest = {
    id: randomUUID(),
    teamId: team.id,
    assignmentId: assignment.id,
    rootId: assignment.rootId,
    requestedByRole: assignment.role,
    targetRole,
    name: input.name,
    trigger: input.trigger,
    instructions: input.instructions,
    schedule: input.schedule ?? null,
    scheduleSummary: input.schedule ? describeSchedule(input.schedule) : null,
    rationale: input.rationale,
    enabled: input.enabled,
    pauseOnFailure: input.pauseOnFailure,
    secretAccountIds: input.secretAccountIds,
    state: isChief ? 'approved' : 'pending_chief',
    createdAt: now,
    ...(isChief ? { decidedAt: now, decidedBy: `chief:${assignment.role}` } : {}),
  };

  let created: { webhook: Webhook; secret: string | null } | undefined;
  if (isChief) {
    created = await instantiateTeamAutomation(team.id, req);
    req.automationId = created.webhook.id;
  }

  const db = await teamAutomationDatabase();
  db.prepare('INSERT INTO assistant_team_automation_requests (id, team_id, assignment_id, root_id, requested_by_role, state, record) VALUES (?,?,?,?,?,?,?)')
    .run(req.id, req.teamId, req.assignmentId, req.rootId, req.requestedByRole, req.state, JSON.stringify(req));
  const { announceTeamChange } = await import('./store.js');
  announceTeamChange(team.id, [req.id, assignment.id]);
  return {
    request: req,
    ...(created ? { automation: { id: created.webhook.id, trigger: created.webhook.trigger, nextRun: created.webhook.nextRun } } : {}),
  };
}

/**
 * Chief (or enrolled human override) approves or rejects a pending specialist automation request.
 * On approval, the real live automation / scheduled task is created immediately on this host node.
 */
export async function decideTeamAutomationRequest(
  teamId: string,
  requestId: string,
  decision: 'approve' | 'reject',
  decidedBy: { kind: 'chief'; role: string } | { kind: 'human'; accountId: string },
  note?: string,
): Promise<TeamAutomationRequest> {
  const db = await teamAutomationDatabase();
  const row = db.prepare('SELECT state, record FROM assistant_team_automation_requests WHERE id=? AND team_id=?')
    .get(requestId, teamId) as { state: TeamAutomationRequestState; record: string } | undefined;
  if (!row) throw new TeamError('Unknown team automation request', 404);
  const existing: TeamAutomationRequest = { ...JSON.parse(row.record) as TeamAutomationRequest, state: row.state };
  if (existing.state !== 'pending_chief') return existing;

  const decidedAt = new Date().toISOString();
  const actorLabel = decidedBy.kind === 'chief' ? `chief:${decidedBy.role}` : `human:${decidedBy.accountId}`;
  const claimedState: TeamAutomationRequestState = decision === 'approve' ? 'approved' : 'rejected';
  const claimed: TeamAutomationRequest = {
    ...existing,
    state: claimedState,
    decidedAt,
    decidedBy: actorLabel,
    ...(note?.trim() ? { decisionNote: note.trim().slice(0, 500) } : {}),
  };
  const changed = db.prepare("UPDATE assistant_team_automation_requests SET state=?, record=? WHERE id=? AND team_id=? AND state='pending_chief'")
    .run(claimedState, JSON.stringify(claimed), requestId, teamId).changes;
  if (!changed) {
    const fresh = db.prepare('SELECT state, record FROM assistant_team_automation_requests WHERE id=?').get(requestId) as { state: TeamAutomationRequestState; record: string };
    return { ...JSON.parse(fresh.record) as TeamAutomationRequest, state: fresh.state };
  }

  let finalReq = claimed;
  if (decision === 'approve') {
    try {
      const created = await instantiateTeamAutomation(teamId, claimed);
      finalReq = { ...claimed, state: 'approved', automationId: created.webhook.id };
    } catch (error) {
      finalReq = { ...claimed, state: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
    db.prepare('UPDATE assistant_team_automation_requests SET state=?, record=? WHERE id=?').run(finalReq.state, JSON.stringify(finalReq), requestId);
  }
  const { announceTeamChange } = await import('./store.js');
  announceTeamChange(teamId, [finalReq.id, finalReq.assignmentId]);
  return finalReq;
}

/** Formats pending specialist automation requests so the Chief can review & decide them immediately. */
export function formatPendingAutomationRequestsForChief(requests: TeamAutomationRequest[]): string {
  if (!requests.length) return '';
  const lines = requests.map(r =>
    `- request ${r.id} (from /${r.requestedByRole} -> target /${r.targetRole}): [${r.trigger}${r.scheduleSummary ? ` · ${r.scheduleSummary}` : ''}] "${r.name}" — Why: ${r.rationale.slice(0, 300)} | Instructions: ${r.instructions.slice(0, 300)}`,
  );
  return `Pending specialist automation/schedule requests awaiting YOUR Chief approval (call team_decide_automation with requestId and decision "approve" or "reject"):\n${lines.join('\n')}`;
}

export function isTeamCoordinatorSync(db: DatabaseSync, teamId: string, role: string): boolean {
  return teamRolesSync(db, teamId).coordinator === role;
}
