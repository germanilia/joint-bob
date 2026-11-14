// What a team is doing and work for it, for a team on this machine or on another machine of the cluster (/api/team-hub).
import { api as request } from './api.js';
import { makeNode, makeButton } from './relay-ui.js';

const api = (path, options = {}) => request(path, { ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
const LABELS = { running: 'running', queued: 'queued', needs_you: 'needs you', stopped: 'stopped', done: 'done', cancelled: 'cancelled' };
const REASONS = {
  dispatch_outcome_unknown: 'stopped without a result; what it already did stays done',
  runtime_unavailable: 'its machine or model was not ready; nothing ran',
  child_outcome_requires_reconciliation: 'waiting on delegated work that stopped',
  cancelled_by_human: 'cancelled',
};
const ago = createdAt => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(createdAt)) / 60000));
  return minutes < 90 ? `${minutes}m` : minutes < 2160 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
};

/**
 * One team's work: a box to send it something (to a member, or to the coordinator who hands it on) and its requests,
 * newest first, with their answers and a way to stop or repeat each. `isCurrent` ends the polling when the person moves on.
 */
export function createTeamWork(teamId, members, { isCurrent, fail }) {
  const node = makeNode('section', 'team-work');
  node.dataset.testid = 'team-work';
  const form = makeNode('div', 'team-work-form');
  const target = makeNode('select'); target.dataset.testid = 'team-work-role'; target.setAttribute('aria-label', 'Send work to');
  const text = makeNode('textarea'); text.dataset.testid = 'team-work-message'; text.rows = 3; text.placeholder = 'What should the team do?';
  const list = makeNode('div', 'team-work-list'); list.dataset.testid = 'team-work-requests';
  let timer;
  const run = fn => () => Promise.resolve().then(fn).catch(fail);
  const refresh = async () => {
    if (!isCurrent()) { stop(); return; }
    const { requests } = await api(`/api/team-hub/${encodeURIComponent(teamId)}/requests`);
    if (!isCurrent()) return;
    list.replaceChildren(...(requests.length ? requests.slice(0, 30).map(row) : [makeNode('p', '', 'No requests yet.')]));
  };
  const act = (verb, shortId) => run(async () => { await api(`/api/team-hub/${encodeURIComponent(teamId)}/${verb}`, { method: 'POST', body: { ref: shortId } }); await refresh(); });
  function row(view) {
    const item = makeNode('article', 'team-record team-work-row'); item.dataset.state = view.state;
    const roles = [...new Set(view.assignments.map(part => part.role))].join(', ');
    item.append(makeNode('strong', '', `${view.shortId} · ${LABELS[view.state]} · ${roles} · ${ago(view.createdAt)}`), makeNode('p', '', view.text));
    const part = view.assignments.find(entry => !entry.delegated);
    if (view.state === 'done' && part?.result) { const answer = makeNode('details'); answer.append(makeNode('summary', '', 'Answer'), makeNode('p', 'team-memory-read', part.result)); answer.open = true; item.append(answer); }
    const why = view.assignments.find(entry => entry.reason && REASONS[entry.reason])?.reason;
    if (['stopped', 'needs_you'].includes(view.state) && why) item.append(makeNode('p', '', REASONS[why]));
    if (['running', 'queued', 'needs_you', 'stopped'].includes(view.state)) item.append(makeButton('Stop', `team-work-cancel-${view.shortId}`, act('cancel', view.shortId)));
    if (['stopped', 'needs_you', 'cancelled'].includes(view.state)) item.append(makeButton('Run again', `team-work-retry-${view.shortId}`, act('retry', view.shortId)));
    return item;
  }
  function setMembers(next) {
    const chosen = target.value;
    target.replaceChildren(...next.map(member => new Option(`${member.coordinator ? 'Coordinator' : member.role}${member.name ? ` — ${member.name}` : ''}${member.ready ? '' : ' (not ready)'}`, member.coordinator ? '' : member.role)));
    if ([...target.options].some(option => option.value === chosen)) target.value = chosen;
  }
  setMembers(members);
  form.append(makeNode('label', 'team-field', 'Send work to ')); form.firstChild.append(target);
  form.append(makeNode('label', 'team-field', 'Work ')); form.lastChild.append(text);
  form.append(makeButton('Send', 'team-work-send', run(async () => {
    const message = text.value.trim();
    if (!message) throw new Error('Write what the team should do.');
    await api(`/api/team-hub/${encodeURIComponent(teamId)}/assign`, { method: 'POST', body: { role: target.value || null, message } });
    text.value = ''; await refresh();
  })));
  node.append(makeNode('h3', '', 'Send work'), form, makeNode('h3', '', 'Requests'), list);
  refresh().catch(fail);
  timer = setInterval(() => refresh().catch(fail), 4000);
  function stop() { clearInterval(timer); }
  return { node, setMembers, refresh, stop };
}
