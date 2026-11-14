import type { TeamRequestView, TeamRequestState } from './assignments.js';

/** Role names that are Telegram commands of their own, so no member may take them. */
export const TEAM_COMMANDS = ['help', 'team', 'status', 'cancel', 'retry'] as const;
export type TeamCommand = typeof TEAM_COMMANDS[number];

const STATE_LABEL: Record<TeamRequestState, string> = { running: 'running', queued: 'queued', needs_you: 'needs you', stopped: 'stopped', done: 'done', cancelled: 'cancelled' };
export const teamRequestStateLabel = (state: TeamRequestState): string => STATE_LABEL[state];

const REASONS: Record<string, string> = {
  dispatch_outcome_unknown: 'stopped without a result; what it already did stays done',
  runtime_unavailable: 'its machine or model was not ready; nothing ran',
  membership_removed_before_dispatch: 'the person who asked is no longer in the team',
  membership_removed_before_publication: 'the person who asked is no longer in the team',
  child_outcome_requires_reconciliation: 'waiting on delegated work that stopped',
  child_results_exceed_context: 'the delegated results were too long to continue from',
  delegation_limit: 'ten delegated turns were used up',
  subject_clarification_required: 'it is not clear which subject this belongs to',
  routing_or_access_refused: 'the message could not be routed',
  cancelled_by_human: 'cancelled',
};
export const teamReasonText = (reason: string | null): string => reason ? (REASONS[reason] ?? reason.split('\n')[0].slice(0, 120)) : '';

function age(createdAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(createdAt)) / 60_000));
  return minutes < 90 ? `${minutes}m` : minutes < 36 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
}
const oneLine = (text: string, length: number): string => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat; };

/** One request for a chat: its short id, state, who works on it, and what it was. */
export function teamRequestLine(view: TeamRequestView, now = Date.now()): string {
  const roles = [...new Set(view.assignments.map(a => a.role))].join(', ');
  return `${view.shortId} · ${teamRequestStateLabel(view.state)} · ${roles} · ${age(view.createdAt, now)} · "${oneLine(view.text, 70)}"`;
}

/** What the team is doing, for the group: counts, then the newest requests. */
export function formatTeamStatus(views: TeamRequestView[], filter: string | null, now = Date.now()): string {
  if (!views.length) return filter ? `Nothing for ${filter} yet.` : 'No requests yet. Send work to a member, for example /qa check the sign-in page.';
  const counts = (Object.keys(STATE_LABEL) as TeamRequestState[]).map(state => [state, views.filter(view => view.state === state).length] as const).filter(([, n]) => n);
  const lines = views.slice(0, 8).map(view => teamRequestLine(view, now));
  const stopped = views.filter(view => view.state === 'stopped' || view.state === 'needs_you').slice(0, 3)
    .flatMap(view => view.assignments.filter(a => a.reason).map(a => `${view.shortId} ${a.role}: ${teamReasonText(a.reason)}`));
  return [`${filter ? `${filter}: ` : ''}${counts.map(([state, n]) => `${n} ${STATE_LABEL[state]}`).join(', ')}`, ...lines, ...(stopped.length ? ['', ...stopped] : []),
    ...(views.length > 8 ? [`(${views.length - 8} older not shown)`] : [])].join('\n');
}

/** One request in full: each member's part, its state, and why it is waiting. */
export function formatTeamRequest(view: TeamRequestView, now = Date.now()): string {
  return [teamRequestLine(view, now), ...view.assignments.map(a => `  ${a.role}${a.delegated ? ' (delegated)' : ''}: ${a.state}${a.reason ? ` — ${teamReasonText(a.reason)}` : ''}`)].join('\n');
}

export function teamHelp(roles: string[], coordinator: string | null): string {
  return [
    `${roles.map(role => `/${role}`).join(' ') || '(no members yet)'} — send work to that member, e.g. /${roles[0] ?? 'qa'} check the sign-in page`,
    '/status [role or id] — what the team is doing',
    '/cancel [id or role] — stop a request',
    '/retry [id] — run a stopped request again as a new one',
    `Anything else in the group is read by ${coordinator ?? 'the team'}, who answers when it is worth it.`,
  ].join('\n');
}
