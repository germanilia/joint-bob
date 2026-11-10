import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
const events = new EventEmitter();
export function onTeamChange(listener: (teamId: string, entityIds: string[]) => void): () => void { events.on('change', listener); return () => { events.off('change', listener); }; }
export function announceTeamChange(teamId: string, entityIds: string[] = []): void { events.emit('change', teamId, entityIds); }
const pendingChanges = new Map<string, Set<string>>();
export function scheduleTeamChange(teamId: string, entityIds: string[] = []): void {
 const pending = pendingChanges.get(teamId);
 if (pending) { for (const id of entityIds) pending.add(id); return; }
 pendingChanges.set(teamId, new Set(entityIds));
 queueMicrotask(() => { const ids = [...pendingChanges.get(teamId)!]; pendingChanges.delete(teamId); announceTeamChange(teamId, ids); });
}
/** Invalidation hints are delivered after synchronous transactions settle; readers reauthorize. */
export function invalidateTeamMembership(db: DatabaseSync, clusterId?: string): void {
 if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_teams'").get()) return;
 const rows = clusterId ? db.prepare('SELECT id FROM assistant_teams WHERE cluster_id=?').all(clusterId) : db.prepare('SELECT id FROM assistant_teams').all();
 for (const row of rows) scheduleTeamChange(String(row.id));
}
