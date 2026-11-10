import { getClusterNode } from '../cluster.js';
import { browserRuntime } from '../server/browser.js';
import { getTeam, selectedTeamBrowser, TeamError, type AssistantTeam, type TeamRole } from './store.js';
import { runningTeamMcp } from './runtime.js';

/** Team access is narrower than ordinary browser access: only an explicit project/cluster share on the execution host counts. */
export async function teamBrowserProfile(team: AssistantTeam, profileId: string): Promise<boolean> {
  if (team.hostNodeId !== (await getClusterNode()).id) return false;
  const runtime = browserRuntime();
  const profile = runtime.profileOrNull(profileId);
  if (!profile) return false;
  const shared = runtime.profileGrants(profileId).some(grant =>
    (grant.scope === 'project' && grant.projectId === team.projectId && (!grant.nodeId || grant.nodeId === team.hostNodeId)) ||
    (grant.scope === 'cluster' && grant.clusterId === team.clusterId));
  return shared && runtime.profileUsable(profileId, { nodeId: team.hostNodeId, projectId: team.projectId, workspaceId: null });
}
export async function requireTeamBrowser(projectId: string, conversationId: string, profileId?: string): Promise<string> {
  const running = await runningTeamMcp(projectId, conversationId);
  if (!running) throw new TeamError('Not a team browser conversation', 403);
  const team = await getTeam(running.team.id);
  if (team.hostNodeId !== (await getClusterNode()).id || team.projectId !== projectId) throw new TeamError('Team browser requires its host node', 403);
  const selected = await selectedTeamBrowser(team.id, running.assignment.role as TeamRole);
  if (!selected || (profileId && selected !== profileId) || !await teamBrowserProfile(team, selected)) throw new TeamError('Team browser profile is not selected or its original share was revoked', 403);
  return selected;
}
