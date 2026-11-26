// What a team is doing and work for it, for a team on this machine or on another machine of the cluster (/api/team-hub).
import { api as request } from './api.js';
import { makeNode, makeButton } from './relay-ui.js';
import { openExecutionDetailModal } from './control-team-modals.js';

const api = (path, options = {}) => request(path, { ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
const LABELS = { running: 'running', queued: 'queued', needs_you: 'needs you', stopped: 'stopped', done: 'done', cancelled: 'cancelled' };
const REASONS = {
  dispatch_outcome_unknown: 'stopped without a result; what it already did stays done',
  runtime_unavailable: 'its machine or model was not ready; nothing ran',
  child_outcome_requires_reconciliation: 'waiting on delegated work that stopped',
  awaiting_proposal_approval: 'waiting for a team member to approve proposed assistant changes',
  cancelled_by_human: 'cancelled',
};
const ago = createdAt => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(createdAt)) / 60000));
  return minutes < 1 ? 'just now' : minutes < 90 ? `${minutes}m ago` : minutes < 2160 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
};
const clip = (s, n) => (!s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * One team's Chief Chat & Activity: send work to Chief or a member, review pending proposals,
 * inspect live/past delegation chains and drill into any assignment's execution trace.
 */
export function createTeamWork(teamId, members, { isCurrent, fail, isLocal = true, openConversation, onRequestsUpdated, onProposalDecided }) {
  const node = makeNode('section', 'team-work');
  node.dataset.testid = 'team-work';
  const form = makeNode('div', 'team-work-form');
  const target = makeNode('select'); target.dataset.testid = 'team-work-role'; target.setAttribute('aria-label', 'Send work to');
  const text = makeNode('textarea'); text.dataset.testid = 'team-work-message'; text.rows = 3; text.placeholder = 'Ask Chief to coordinate work, or address a specific role…';
  const proposalsHeading = makeNode('h3', 'team-section-title', 'Pending Chief proposals');
  const proposalsList = makeNode('div', 'team-work-proposals'); proposalsList.dataset.testid = 'team-work-proposals';
  const automationsHeading = makeNode('h3', 'team-section-title', 'Team Automations & Schedules');
  const automationsList = makeNode('div', 'team-work-automations'); automationsList.dataset.testid = 'team-work-automations';
  const list = makeNode('div', 'team-work-list'); list.dataset.testid = 'team-work-requests';
  let timer;
  let lastRequests = [];
  const run = fn => () => Promise.resolve().then(fn).catch(fail);

  const decideProposal = (proposalId, decision) => run(async () => {
    await api(`/api/team-hub/${encodeURIComponent(teamId)}/proposals/${encodeURIComponent(proposalId)}/decide`, { method: 'POST', body: { decision } });
    await refresh();
    onProposalDecided?.();
  });

  function proposalRow(proposal) {
    const item = makeNode('article', 'team-record team-proposal-card'); item.dataset.state = proposal.state;
    const head = makeNode('div', 'team-row-head');
    head.append(makeNode('strong', '', `/${proposal.proposedByRole} proposes: ${proposal.summary}`), makeNode('span', `team-pill state-${proposal.state}`, proposal.state));
    item.append(head, makeNode('p', 'team-muted', proposal.rationale));
    const changesList = makeNode('ul', 'team-proposal-changes');
    for (const preview of proposal.previews ?? []) {
      const li = makeNode('li', '');
      const details = makeNode('details');
      details.append(makeNode('summary', '', preview.headline), makeNode('pre', 'team-memory-read', preview.detail));
      li.append(details);
      changesList.append(li);
    }
    item.append(changesList);
    if (proposal.state === 'pending') {
      const actions = makeNode('div', 'team-row-actions');
      const approve = makeButton('Approve & Apply', `team-proposal-approve-${proposal.id}`, decideProposal(proposal.id, 'approve'));
      approve.className = 'primary compact';
      const reject = makeButton('Reject', `team-proposal-reject-${proposal.id}`, decideProposal(proposal.id, 'reject'));
      reject.className = 'ghost compact';
      actions.append(approve, reject);
      item.append(actions);
    } else if (proposal.state === 'applied' && proposal.appliedSummary?.length) {
      item.append(makeNode('p', 'team-muted', `Applied: ${proposal.appliedSummary.join('; ')}`));
    } else if (proposal.state === 'failed' && proposal.error) {
      item.append(makeNode('p', 'team-error-inline', `Failed: ${proposal.error}`));
    }
    return item;
  }

  const decideAutomation = (requestId, decision) => run(async () => {
    await api(`/api/assistant-teams/${encodeURIComponent(teamId)}/automations/requests/${encodeURIComponent(requestId)}/decide`, { method: 'POST', body: { decision } });
    await refresh();
  });

  function automationCard(entry, isRequest) {
    const item = makeNode('article', 'team-record team-proposal-card');
    const head = makeNode('div', 'team-row-head');
    const label = isRequest
      ? `/${entry.requestedByRole} requests ${entry.trigger}: ${entry.name}`
      : `${entry.trigger === 'schedule' ? 'Schedule' : 'Webhook'}: ${entry.name}`;
    const stateLabel = isRequest ? entry.state.replaceAll('_', ' ') : (entry.enabled ? 'active' : 'paused');
    head.append(makeNode('strong', '', label), makeNode('span', `team-pill state-${isRequest ? entry.state : (entry.enabled ? 'done' : 'stopped')}`, stateLabel));
    item.append(head);
    const meta = [entry.targetRole ? `/${entry.targetRole}` : null, entry.scheduleSummary || (entry.trigger === 'webhook' ? 'Webhook trigger' : null)].filter(Boolean).join(' · ');
    if (meta) item.append(makeNode('p', 'team-muted', meta));
    if (isRequest && entry.rationale) item.append(makeNode('p', 'team-muted', entry.rationale));
    if (isRequest && entry.state === 'pending_chief') {
      const actions = makeNode('div', 'team-row-actions');
      const approve = makeButton('Approve', `team-auto-approve-${entry.id}`, decideAutomation(entry.id, 'approve'));
      approve.className = 'primary compact';
      const reject = makeButton('Reject', `team-auto-reject-${entry.id}`, decideAutomation(entry.id, 'reject'));
      reject.className = 'ghost compact';
      actions.append(approve, reject);
      item.append(actions);
    }
    return item;
  }

  const refresh = async () => {
    if (!isCurrent()) { stop(); return; }
    const [{ requests }, proposalsRes, automationsRes] = await Promise.all([
      api(`/api/team-hub/${encodeURIComponent(teamId)}/requests`),
      api(`/api/team-hub/${encodeURIComponent(teamId)}/proposals`).catch(() => ({ proposals: [] })),
      isLocal ? api(`/api/assistant-teams/${encodeURIComponent(teamId)}/automations`).catch(() => ({ automations: [], requests: [] })) : Promise.resolve({ automations: [], requests: [] }),
    ]);
    if (!isCurrent()) return;
    lastRequests = requests ?? [];
    onRequestsUpdated?.(lastRequests);
    const pending = (proposalsRes.proposals ?? []).filter(p => p.state === 'pending');
    proposalsHeading.hidden = !pending.length;
    proposalsList.hidden = !pending.length;
    proposalsList.replaceChildren(...pending.map(proposalRow));
    const pendingAutoReqs = (automationsRes.requests ?? []).filter(r => r.state === 'pending_chief');
    const liveAutos = automationsRes.automations ?? [];
    const hasAutos = pendingAutoReqs.length > 0 || liveAutos.length > 0;
    automationsHeading.hidden = !hasAutos;
    automationsList.hidden = !hasAutos;
    automationsList.replaceChildren(
      ...pendingAutoReqs.map(r => automationCard(r, true)),
      ...liveAutos.map(a => automationCard(a, false)),
    );
    list.replaceChildren(...(lastRequests.length ? lastRequests.slice(0, 30).map(row) : [makeNode('p', 'team-muted', 'No requests yet. Ask Chief above to start coordinating work.')]));
  };

  const act = (verb, shortId) => run(async () => { await api(`/api/team-hub/${encodeURIComponent(teamId)}/${verb}`, { method: 'POST', body: { ref: shortId } }); await refresh(); });

  function row(view) {
    const item = makeNode('article', 'team-record team-work-row'); item.dataset.state = view.state;
    const head = makeNode('div', 'team-row-head');
    const left = makeNode('div', 'team-row-meta');
    const roles = [...new Set(view.assignments.map(part => `/${part.role}`))].join(', ');
    left.append(
      makeNode('span', `team-pill state-${view.state}`, LABELS[view.state] || view.state),
      makeNode('code', 'team-short-id', `#${view.shortId}`),
      makeNode('span', 'team-muted', `${roles} · ${ago(view.createdAt)}`),
    );
    const controls = makeNode('div', 'team-row-actions');
    if (['running', 'queued', 'needs_you', 'stopped'].includes(view.state)) {
      const stopBtn = makeButton('Stop', `team-work-cancel-${view.shortId}`, act('cancel', view.shortId));
      stopBtn.className = 'ghost compact';
      controls.append(stopBtn);
    }
    if (['stopped', 'needs_you', 'cancelled'].includes(view.state)) {
      const retryBtn = makeButton('Run again', `team-work-retry-${view.shortId}`, act('retry', view.shortId));
      retryBtn.className = 'ghost compact';
      controls.append(retryBtn);
    }
    head.append(left, controls);
    item.append(head, makeNode('p', 'team-request-text', view.text));

    // Delegation / execution chain with per-assignment drill-down.
    if (view.assignments.length) {
      const chain = makeNode('div', 'team-delegation-chain');
      for (const part of view.assignments) {
        const chip = makeNode('div', 'team-assignment-chip');
        const info = makeNode('div', 'team-assignment-info');
        info.append(
          makeNode('code', '', `/${part.role}`),
          makeNode('span', `team-pill state-${part.state}`, part.state.replaceAll('_', ' ')),
          ...(part.delegated ? [makeNode('span', 'team-muted', 'delegated')] : []),
          ...(part.prompt && part.delegated ? [makeNode('span', 'team-muted', clip(part.prompt, 90))] : []),
        );
        chip.append(info);
        if (isLocal && part.id) {
          const inspectBtn = makeButton('Inspect execution →', `team-inspect-${part.id}`, () => {
            void openExecutionDetailModal(teamId, part.id, { openConversation });
          });
          inspectBtn.className = 'ghost compact team-inspect-btn';
          chip.append(inspectBtn);
        }
        chain.append(chip);
      }
      item.append(chain);
    }

    const part = view.assignments.find(entry => !entry.delegated && entry.result) ?? view.assignments.find(entry => !entry.delegated);
    if (view.state === 'done' && part?.result) {
      const answer = makeNode('details', 'team-answer-box');
      answer.append(makeNode('summary', '', 'Answer'), makeNode('div', 'team-memory-read', part.result));
      answer.open = true;
      item.append(answer);
    }
    const why = view.assignments.find(entry => entry.reason && REASONS[entry.reason])?.reason;
    if (['stopped', 'needs_you'].includes(view.state) && why) item.append(makeNode('p', 'team-muted', REASONS[why]));
    return item;
  }

  function setMembers(next) {
    const chosen = target.value;
    target.replaceChildren(...next.map(member => new Option(`${member.coordinator ? `Chief (/${member.role})` : `/${member.role}`}${member.name ? ` — ${member.name}` : ''}${member.ready ? '' : ' (not ready)'}`, member.coordinator ? '' : member.role)));
    if ([...target.options].some(option => option.value === chosen)) target.value = chosen;
  }

  setMembers(members);
  const topBar = makeNode('div', 'team-work-composer-top');
  const targetLabel = makeNode('label', 'team-inline-field');
  targetLabel.append(makeNode('span', '', 'Send to'), target);
  topBar.append(targetLabel);
  const sendBtn = makeButton('Send to Team', 'team-work-send', run(async () => {
    const message = text.value.trim();
    if (!message) throw new Error('Write what the team should do.');
    await api(`/api/team-hub/${encodeURIComponent(teamId)}/assign`, { method: 'POST', body: { role: target.value || null, message } });
    text.value = ''; await refresh();
  }));
  sendBtn.className = 'primary compact';
  const sendBar = makeNode('div', 'team-row-actions');
  sendBar.append(sendBtn);
  form.append(topBar, text, sendBar);

  proposalsHeading.hidden = true;
  proposalsList.hidden = true;
  automationsHeading.hidden = true;
  automationsList.hidden = true;
  node.append(makeNode('h3', 'team-section-title', 'Chief Chat & Dispatch'), form, proposalsHeading, proposalsList, automationsHeading, automationsList, makeNode('h3', 'team-section-title', 'Team Activity'), list);
  refresh().catch(fail);
  timer = setInterval(() => refresh().catch(fail), 4000);
  function stop() { clearInterval(timer); }
  return { node, setMembers, refresh, stop, latestRequests: () => lastRequests };
}
