import type WebSocket from 'ws';
import type { MessageAuthor } from '../message-authors.js';
import { canonicalLocalHome } from '../accounts.js';
import { getClusterNode } from '../cluster.js';
import { verifyReceivedMember } from '../assistant-teams/access.js';
import { onTeamChange } from '../assistant-teams/invalidation.js';
import { teamDatabase } from '../assistant-teams/store.js';
import { detachHarnessClient, harnessSessions } from './harness-sessions.js';
import { watchClients } from './state.js';

/** Only team projects opt in; ordinary private-project socket semantics are unchanged. */
export async function guardTeamSocket(socket: WebSocket, projectId: string, author: MessageAuthor | undefined): Promise<void> {
  const db = await teamDatabase();
  const team = db.prepare('SELECT cluster_id FROM assistant_team_projects WHERE project_id=?').get(projectId) as { cluster_id: string } | undefined;
  if (!team || !author) return; // Node-internal connections retain their existing authorization.
  const local = (await getClusterNode()).id;
  const member = { clusterId: team.cluster_id, accountId: author.accountId, username: author.username, homeNodeId: author.homeNodeId ?? canonicalLocalHome(db) };
  const check = (): boolean => {
    try {
      if (!db.prepare('SELECT 1 FROM sharing_memberships WHERE cluster_id=? AND node_id=?').get(team.cluster_id, local)) throw new Error('Host left cluster');
      verifyReceivedMember(db, member);
      return true;
    } catch {
      // Detach immediately, not after the peer completes the close handshake.
      for (const shared of harnessSessions.values()) if (shared.clients.has(socket)) detachHarnessClient(shared, socket);
      watchClients.get(projectId)?.delete(socket);
      socket.close(1008, 'Team membership revoked');
      return false;
    }
  };
  // Checking the installed snapshot synchronously at the write boundary also covers
  // ready/history/replay and events between a transaction and its invalidation hint.
  const send = socket.send.bind(socket);
  socket.send = ((...args: Parameters<WebSocket['send']>) => { if (check()) send(...args); }) as WebSocket['send'];
  const dispose = onTeamChange(() => { check(); });
  socket.once('close', dispose);
  check();
}
