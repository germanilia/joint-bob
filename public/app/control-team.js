// Shared host team context. Personal Bob's views and settings are deliberately untouched.
import { api as request } from './api.js';
const api = (path, options = {}) => request(path, { ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
import { makeNode, makeButton } from './relay-ui.js';
import { registerContextView, setControlContext, showControlView } from './control-views.js';
import { renderTeamTelegram } from './control-team-telegram.js';
import { createTeamWork } from './control-team-work.js';
import { openConversation } from './control-center.js';

const panels = Object.fromEntries(['assistants', 'live', 'memory'].map(id => {
  const panel = makeNode('section', 'control-view team-control');
  panel.dataset.testid = `team-${id}-view`;
  panel.setAttribute('role', 'tabpanel');
  document.querySelector('#controlViews').append(panel);
  registerContextView(id, panel, id === 'assistants' ? 'Team members' : undefined);
  return [id, panel];
}));
const settingsPanel = document.querySelector('#settingsPanel-account');
const tagged = (node, id) => { node.dataset.testid = id; return node; };
const select = tagged(makeNode('select'), 'team-select');
select.setAttribute('aria-label', 'Shared team');
const error = tagged(makeNode('p'), 'team-error'); error.setAttribute('role', 'alert');
const saved = makeNode('p'); saved.setAttribute('role', 'status');
const contextLabel = makeNode('label', 'team-context-label', 'Context ');
contextLabel.append(select);
document.querySelector('#controlTabs').before(contextLabel);
const button = (text, id, fn) => makeButton(text, id, () => Promise.resolve().then(fn).catch(fail));
const mobileEntry = button('Shared team', 'team-phone-open', async () => { await loadTeams(); showControlView('assistants'); });
mobileEntry.classList.add('team-phone-entry');
document.querySelector('.control-chat-head')?.append(mobileEntry);
window.addEventListener('control-view-changed', event => document.body.classList.toggle('team-phone-live', event.detail.id === 'live'));
const phoneNav = makeNode('nav', 'team-phone-nav');
for (const [view, label] of [['assistants', 'Roles'], ['live', 'Activity'], ['memory', 'Memory']]) phoneNav.append(button(label, `team-phone-${view}`, () => showControlView(view)));
document.querySelector('#controlViews').prepend(phoneNav);
const mobileSelect = tagged(makeNode('select'), 'team-phone-select');
mobileSelect.setAttribute('aria-label', 'Shared team on phone');
mobileSelect.addEventListener('change', () => { select.value = mobileSelect.value; select.dispatchEvent(new Event('change')); });
const mobileContext = makeNode('label', 'team-phone-context', 'Shared team '); mobileContext.append(mobileSelect);
document.querySelector('#controlViews').prepend(mobileContext);
const syncMobile = () => { mobileSelect.replaceChildren(...[...select.options].map(option => new Option(option.text, option.value))); mobileSelect.value = select.value; };
const settings = makeNode('section', 'team-control team-settings-area');
settings.append(makeNode('h2', '', 'Shared team settings · personal Bob is separate'), error, saved);
settingsPanel.append(settings);
let team, stream, work, hubTeams = new Map(), generation = 0, refreshGeneration = 0, editingSettings = false;
const current = (mine, url) => mine === generation && select.value && base() === url;
const updateRevision = async (url, mine) => {
  const record = await api(url);
  if (current(mine, url) && team) team.revision = record.team.revision;
};
const base = () => `/api/assistant-teams/${encodeURIComponent(select.value)}`;
const fail = e => {
  error.textContent = e.message;
  if (!settingsPanel.closest('dialog')?.open && select.value) {
    const visible = Object.values(panels).find(panel => !panel.hidden);
    if (visible) visible.prepend(error);
  }
};
function input(parent, label, id, value, type = 'text') {
  const wrapper = makeNode('label', 'team-field', label), field = tagged(makeNode(type === 'textarea' ? 'textarea' : 'input'), id);
  if (type !== 'textarea') field.type = type;
  field.value = value ?? ''; wrapper.append(field); parent.append(wrapper); return field;
}
async function loadTeams() {
  if (select.options.length) return;
  // Built aside and put in at once: a failed load leaves the list empty, so the next opening tries again.
  // The teams of every cluster the person joined, on whichever machine hosts each; a team on another machine is steered from here.
  const [{ clusters }, { teams }] = await Promise.all([api('/api/clusters'), api('/api/team-hub')]);
  hubTeams = new Map(teams.map(item => [item.id, item]));
  const options = [new Option(teams.length || clusters.length ? 'Select a team' : 'No cluster yet: create one under Clusters', '')];
  for (const item of teams) options.push(new Option(item.local ? item.clusterName : `${item.clusterName} — on ${item.hostName}`, item.local ? item.id : `remote:${item.id}`));
  // A team is made on this host only for a cluster that has none anywhere.
  for (const cluster of clusters) if (!teams.some(item => item.clusterId === cluster.id)) options.push(new Option(`${cluster.name} — create team on this host`, `create:${cluster.id}`));
  if (select.options.length) return;
  select.replaceChildren(...options);
  syncMobile();
}
async function refresh(force = false) {
  const mine = generation;
  if (!force && (document.querySelector('.team-editor') || editingSettings || document.querySelector('#settingsDialog')?.open || (settings.contains(document.activeElement) && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)))) return;
  const refreshRequest = ++refreshGeneration;
  if (!select.value) { team = undefined; for (const panel of Object.values(panels)) panel.replaceChildren(); settings.replaceChildren(error, saved); return; }
  const url = base();
  const [record, agents, readiness] = await Promise.all([api(url), api(`${url}/agents`), api(`${url}/readiness`)]);
  if (mine !== generation || refreshRequest !== refreshGeneration) return;
  // Do not destroy a member's in-progress editor when another member changes the team.
  if (!force && (document.querySelector('.team-editor') || editingSettings || document.querySelector('#settingsDialog')?.open || (settings.contains(document.activeElement) && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)))) return;
  team = record.team;
  const openSections = [...document.querySelectorAll('.team-control details[open]')].map(node => node.firstChild.textContent);
  for (const panel of Object.values(panels)) panel.replaceChildren();
  if (work) { work.setMembers(agents.agents.map(agent => ({ role: agent.role, name: agent.profile?.name ?? null, coordinator: agent.coordinator, ready: !agent.readiness.length }))); panels.live.append(work.node); }
  settings.replaceChildren(makeNode('h2', '', 'Shared team settings · personal Bob is separate'), error, saved);
  panels.assistants.append(makeNode('h2', '', 'Shared team assistants'), makeNode('p', '', `Host: ${readiness.host.name}`), tagged(makeNode('p', '', 'Pick your assistants on this machine and give each a role. A member brings everything it has: instructions, skills, MCP servers, browser logins and tools. Its role is its Telegram command.'), 'team-runtime'));
  const decision = makeNode('p', '', `Central AI decision: ${readiness.decision.model ?? 'not selected'} · ${readiness.decision.ready ? 'ready' : 'unavailable'}. Configure in Settings → System AI.`);
  decision.append(button('System AI settings', 'team-decision-settings', async () => (await import('./settings.js')).openSettings('system-ai')));
  panels.assistants.append(decision);
  panels.assistants.append(button('Team settings and Telegram', 'team-open-settings', async () => (await import('./settings.js')).openSettings('account')));
  const thresholds = makeNode('div', 'team-settings');
  const ask = input(thresholds, 'Ask (%)', 'team-ask', team.settings.askThreshold * 100, 'number');
  const act = input(thresholds, 'Act (%)', 'team-act', team.settings.actThreshold * 100, 'number');
  for (const field of [ask, act]) { field.min = '0'; field.max = '100'; field.step = 'any'; field.addEventListener('input', () => { editingSettings = true; }); }
  thresholds.append(button('Save thresholds', 'team-settings-save', async () => {
    const a = Number(ask.value), b = Number(act.value);
    if (!ask.value || !act.value || !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > 100 || a >= b) throw new Error('Ask must be below Act (0–100%).');
    await api(`${url}/settings`, { method: 'PUT', body: { expectedRevision: team.revision, settings: { askThreshold: a / 100, actThreshold: b / 100 } } });
    team = (await api(url)).team;
    editingSettings = false; error.textContent = ''; saved.dataset.testid = 'team-saved'; saved.textContent = 'Saved';
  })); settings.append(thresholds);
  await renderMembers(panels.assistants, url, agents);
  const telegram = makeNode('details'); telegram.append(tagged(makeNode('summary', '', 'Telegram enrollment and group'), 'team-telegram-toggle'));
  if (openSections.includes('Telegram enrollment and group')) telegram.open = true;
  settings.append(telegram); await renderTeamTelegram(telegram, url, fail, () => refresh(true));
  if (!current(mine, url) || refreshRequest !== refreshGeneration) return;
  const learning = tagged(makeNode('div', 'team-learning'), 'team-learning');
  panels.memory.append(learning);
  const status = await api(`${url}/memory/status`);
  if (!current(mine, url) || refreshRequest !== refreshGeneration) return;
  const attention = status.learning.filter(entry => ['waiting', 'decision_unavailable', 'writer_unavailable', 'memory_failed', 'file_pending'].includes(entry.status));
  learning.textContent = attention.length ? `Memory learning: ${attention.map(entry => `${entry.message_id}: ${entry.status.replaceAll('_', ' ')}`).join(' · ')}` : 'Memory learning: no pending or failed messages';
  for (const [name, endpoint, key] of [['Activity', 'assignments', 'assignments'], ['Messages', 'messages', 'messages'], ['Decisions', 'decisions', 'decisions'], ['Memory topics', 'memory/topics', 'topics'], ['Memory changes', 'memory/changes', 'changes']]) {
    const section = makeNode('details'); section.append(tagged(makeNode('summary', '', name), `team-${key}-toggle`));
    if (openSections.includes(name)) section.open = true;
    const list = tagged(makeNode('div', 'team-page'), `team-${key}`);
    const pager = makeNode('nav', 'team-pager'); section.append(list, pager); (key === 'topics' || key === 'changes' ? panels.memory : panels.live).append(section);
    let offset = 0, pageSize = 1, request = 0;
    const generationAtRender = mine;
    const show = async () => {
      const mine = ++request;
      // Fetch one lookahead page; the visible count is determined by actual row geometry below.
      const data = await api(`${url}/${endpoint}?offset=${key === 'assignments' ? 0 : offset}&limit=100`);
      if (mine !== request || !current(generationAtRender, url) || !section.isConnected) return;
      const activity = key === 'assignments' ? [
        ...data.inquiries.filter(i => i.state === 'pending').map(value => ({ kind: 'inquiry', value })),
        ...data.approvals.filter(a => a.state === 'pending').map(value => ({ kind: 'approval', value })),
        ...data.assignments.map(value => ({ kind: 'assignment', value }))
      ] : [];
      const rows = key === 'assignments' ? activity.slice(offset) : data[key] ?? []; list.replaceChildren();
      if (key === 'topics') list.append(button('New topic', 'team-memory-new', () => editMemory(url, list, '', 0)));
      if (key === 'assignments') {
        for (const entry of rows.filter(r => r.kind === 'inquiry')) {
          const inquiry = entry.value;
          const item = makeNode('article', 'team-record', inquiry.source.text);
          for (const choice of ['confirm', 'dismiss']) item.append(button(choice, `team-inquiry-${choice}`, async () => { await api(`${url}/inquiries/${inquiry.id}/confirm`, { method: 'POST', body: { decision: choice } }); await show(); }));
          list.append(item);
        }
        for (const entry of rows.filter(r => r.kind === 'approval')) {
          const approval = entry.value;
          const item = makeNode('article', 'team-record', approval.reason ?? 'Guardian approval required');
          for (const allow of [false, true]) item.append(button(allow ? 'Allow' : 'Deny', `team-approval-${allow}`, async () => { await api(`${url}/assignments/${approval.team.assignmentId}/reviews/${approval.id}`, { method: 'POST', body: { allow } }); await show(); }));
          list.append(item);
        }
      }
      for (const entry of rows.filter(r => key !== 'assignments' || r.kind === 'assignment')) {
        const row = key === 'assignments' ? entry.value : entry;
        const item = makeNode('article', 'team-record');
        item.append(makeNode('h4', '', row.role ?? row.name ?? row.topic ?? row.title ?? row.status ?? 'Message'));
        item.append(makeNode('p', '', row.text ?? row.description ?? row.failure?.message ?? row.state ?? ''));
        if (key === 'assignments') {
          const work = data.work.find(w => w.assignmentId === row.id);
          item.append(makeNode('p', '', `${row.parentId ? 'Delegated' : 'Direct'} · ${work?.reason ?? ''}`));
          if (work?.result) item.append(makeNode('p', '', work.result));
          if (work?.conversationId) item.append(button('Conversation', 'team-conversation', () => openConversation({ projectId: team.projectId, conversationId: work.conversationId, engine: 'pi' })));
          if (!row.subjectId && ['accepted', 'waiting_for_human'].includes(row.state)) item.append(button('Confirm new subject', 'team-route-new', () => api(`${url}/assignments/${row.id}/route`, { method: 'POST', body: { kind: 'new' } })));
          for (const delivery of data.deliveries.filter(d => d.assignmentId === row.id)) item.append(makeNode('p', '', `Delivery: ${delivery.state}${delivery.state === 'uncertain' ? ' — outcome unknown; do not blindly retry' : ''}`));
        }
        if (key === 'topics') {
          for (const link of row.links ?? []) item.append(button(`[[${link}]]`, 'team-memory-link', () => editMemory(url, item, link, 0)));
          item.append(button('Read / edit', 'team-memory-edit', () => editMemory(url, item, row.name ?? row.topic, row.revision)));
        }
        if (key === 'changes') {
          item.append(makeNode('p', '', `Revision ${row.revision} · ${row.actor} · ${row.created_at}`));
          item.append(button('Revert this revision', 'team-memory-revert', () => api(`${url}/memory/changes/${row.id}/revert`, { method: 'POST', body: { expectedRevision: row.revision } })));
          for (const source of JSON.parse(row.sources || '[]')) item.append(button('Source', 'team-memory-source', async () => { const { message } = await api(`${url}/messages/${source}`); item.append(makeNode('p', '', message.text)); }));
        }
        if (key === 'decisions') item.append(makeNode('p', '', `Decision ${row.status} · ${row.model ?? 'unavailable'} · ${row.waitingReason ?? row.result?.attention ?? ''}`));
        const sourceId = row.sourceMessageId ?? row.messageId;
        if (sourceId) item.append(button('Original source', 'team-source', async () => {
          const { message } = await api(`${url}/messages/${encodeURIComponent(sourceId)}`);
          item.append(makeNode('p', '', message.text));
        }));
        list.append(item);
      }
      // Keep only complete rows within the measured list height; do not make a hidden scroll region.
      const records = [...list.querySelectorAll('.team-record')];
      pageSize = Math.max(1, records.length);
      while (pageSize > 1 && list.scrollHeight > list.clientHeight + 1) records[--pageSize].remove();
      if (pageSize === 1 && list.scrollHeight > list.clientHeight + 1) records[0]?.classList.add('team-record-tall');
      const prev = button('Previous', `team-${key}-prev`, () => { offset = Math.max(0, offset - pageSize); return show(); }); prev.disabled = offset === 0;
      const next = button('Next', `team-${key}-next`, () => { offset += pageSize; return show(); }); next.disabled = rows.length <= pageSize;
      pager.replaceChildren(prev, makeNode('span', '', `${offset + 1}–${offset + pageSize}`), next);
    };
    new ResizeObserver(() => { if (section.open && section.isConnected && !list.querySelector('input, textarea')) show().catch(fail); }).observe(list);
    section.addEventListener('toggle', () => { if (section.open) show().catch(fail); });
  }
}
/** Members are picked assistants with a free role name; one of them coordinates. */
async function renderMembers(parent, url, agents) {
  const mine = generation;
  const { assistants } = await api(`${url}/available-assistants`);
  if (!current(mine, url)) return;
  const rows = agents.agents.map(agent => ({ role: agent.role, assistantId: agent.assistantId, profile: agent.profile, readiness: agent.readiness }));
  let coordinator = agents.coordinatorRole;
  const list = tagged(makeNode('div', 'team-cards'), 'team-members');
  const save = async () => {
    const result = await api(`${url}/members`, { method: 'PUT', body: { expectedRevision: team.revision, coordinatorRole: rows.some(row => row.role === coordinator) ? coordinator : null, members: rows.map(({ role, assistantId }) => ({ role, assistantId })) } });
    team.revision = result.revision; error.textContent = ''; await refresh(true);
  };
  for (const row of rows) {
    const card = tagged(makeNode('article', 'team-card'), 'team-agent-card'); card.dataset.role = row.role;
    card.append(makeNode('h3', '', `/${row.role} · ${row.profile?.name ?? 'deleted assistant'}${row.role === coordinator ? ' · coordinator' : ''}`));
    card.append(tagged(makeNode('p', '', row.profile ? `Uses: ${row.profile.uses.join(', ') || 'no extra resources'}` : ''), 'team-member-uses'));
    card.append(makeNode('p', '', row.readiness.join(' · ') || 'Ready'));
    const role = input(card, 'Role (Telegram command)', 'team-member-role', row.role);
    role.addEventListener('change', () => { if (coordinator === row.role) coordinator = role.value.trim(); row.role = role.value.trim(); });
    if (row.role !== coordinator) card.append(button('Make coordinator', 'team-member-coordinator', () => { coordinator = row.role; return save(); }));
    card.append(button('Remove', 'team-member-remove', () => { rows.splice(rows.indexOf(row), 1); return save(); }));
    list.append(card);
  }
  parent.append(list);
  const add = makeNode('div', 'team-settings');
  const choices = assistants.filter(item => !item.inTeam);
  const pick = tagged(makeNode('select'), 'team-member-pick'); pick.setAttribute('aria-label', 'Assistant to add');
  pick.replaceChildren(...(choices.length ? choices.map(item => new Option(`${item.name} — ${item.uses.join(', ') || 'no extra resources'}`, item.id)) : [new Option('No other assistants of yours on this machine', '')]));
  const newRole = input(add, 'Role', 'team-member-new-role', '');
  add.prepend(pick);
  add.append(button('Add to team', 'team-member-add', () => {
    if (!pick.value) throw new Error('Create an assistant on this machine first.');
    if (!newRole.value.trim()) throw new Error('Give the new member a role, for example qa.');
    rows.push({ role: newRole.value.trim(), assistantId: pick.value });
    return save();
  }));
  add.append(button('Save roles', 'team-members-save', save));
  parent.append(add);
}
async function editMemory(url, parent, topic, revision) {
  const mine = generation;
  const current = topic ? await api(`${url}/memory/topics/${encodeURIComponent(topic)}`) : { text: '', revision: 0 };
  if (!select.value || mine !== generation || base() !== url) return;
  panels.memory.querySelector('.team-memory-editor-pane')?.remove();
  const pane = tagged(makeNode('section', 'team-memory-editor-pane'), 'team-memory-editor-pane');
  panels.memory.prepend(pane);
  const editor = makeNode('div', 'team-editor');
  if (current.text) {
    const read = tagged(makeNode('div', 'team-memory-read'), 'team-memory-read');
    for (const part of current.text.split(/(\[\[[a-z0-9-]+\]\]|\[message [^\]]+\]\([^)]*\/messages\/[^)]*\)|\[conversation [^\]]+\]\(\/\?[^)]*\))/g)) {
      const topicLink = /^\[\[([a-z0-9-]+)\]\]$/.exec(part);
      const sourceLink = /^\[message ([^\]]+)\]\([^)]*\/messages\/[^)]*\)$/.exec(part);
      const conversationLink = /^\[conversation ([^\]]+)\]\(\/\?([^)]*)\)$/.exec(part);
      if (topicLink) read.append(button(topicLink[1], 'team-memory-link', () => editMemory(url, editor, topicLink[1], 0)));
      else if (sourceLink) read.append(button(`Source ${sourceLink[1]}`, 'team-memory-source', async () => { const { message } = await api(`${url}/messages/${encodeURIComponent(sourceLink[1])}`); read.append(makeNode('p', '', message.text)); }));
      else if (conversationLink) read.append(button(`Conversation ${conversationLink[1]}`, 'team-memory-conversation', () => { const params = new URLSearchParams(conversationLink[2]); return openConversation({ projectId: params.get('project'), conversationId: params.get('conversation'), engine: 'pi' }); }));
      else read.append(document.createTextNode(part));
    }
    editor.append(read);
  }
  const name = input(editor, 'Topic name', 'team-memory-name', topic); name.disabled = Boolean(topic);
  const parts = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(current.text);
  const description = input(editor, 'Description', 'team-memory-description', parts?.[1].match(/^description: (.*)$/m)?.[1] || topic || 'Shared team knowledge');
  const body = input(editor, 'Memory text', 'team-memory-body', parts ? parts[2].trim() : current.text, 'textarea');
  const sources = input(editor, 'Source message IDs (comma separated, from this team)', 'team-memory-sources', '');
  editor.append(button('Save memory', 'team-memory-save', async () => {
    if (mine !== generation || base() !== url) return;
    await api(`${url}/memory/topics/${encodeURIComponent(name.value)}`, { method: 'PUT', body: { expectedRevision: current.revision, description: description.value, body: body.value, sourceMessageIds: sources.value.split(',').map(value => value.trim()).filter(Boolean) } });
    if (mine !== generation || base() !== url) return;
    pane.remove(); await refresh();
  }), button('Cancel', 'team-memory-cancel', () => pane.remove()));
  pane.append(editor);
  pane.scrollIntoView({ block: 'nearest' });
}
select.addEventListener('change', () => {
  ++generation; stream?.close(); stream = undefined; team = undefined; editingSettings = false; error.textContent = '';
  work?.stop(); work = undefined;
  syncMobile();
  document.body.classList.toggle('team-context-active', Boolean(select.value));
  for (const panel of Object.values(panels)) panel.replaceChildren();
  settings.replaceChildren(error, saved);
  setControlContext(select.value);
  if (!select.value) return;
  if (select.value.startsWith('create:')) {
    const clusterId = select.value.slice(7);
    const mine = generation;
    api('/api/assistant-teams', { method: 'POST', body: { clusterId } }).then(async result => {
      if (mine !== generation) return;
      select.replaceChildren(); await loadTeams(); if (mine !== generation) return; select.value = result.team.id; select.dispatchEvent(new Event('change')); showControlView('assistants');
    }).catch(fail); return;
  }
  if (select.value.startsWith('remote:')) {
    // A team on another machine: its work is steered from here; its members, Telegram and memory are managed on its host.
    const remote = hubTeams.get(select.value.slice(7)), mine = generation;
    const intro = makeNode('section', 'team-card');
    intro.append(makeNode('h2', '', `${remote.clusterName} team`), makeNode('p', '', `Hosted on ${remote.hostName}. Send it work and read its answers here; its members, Telegram and memory are managed on that machine.`),
      makeNode('ul', '', undefined));
    for (const member of remote.members) intro.lastChild.append(makeNode('li', '', `${member.coordinator ? 'coordinator' : member.role}${member.coordinator ? ` (${member.role})` : ''}${member.name ? ` — ${member.name}` : ''}${member.ready ? '' : ' · not ready on its machine'}${member.uses.length ? ` · uses ${member.uses.join(', ')}` : ''}`));
    panels.assistants.append(intro);
    work = createTeamWork(remote.id, remote.members, { isCurrent: () => mine === generation, fail });
    panels.live.append(work.node);
    return;
  }
  const here = generation;
  work = createTeamWork(select.value, hubTeams.get(select.value)?.members ?? [], { isCurrent: () => here === generation, fail });
  const connection = new EventSource(`${base()}/events`);
  stream = connection;
  connection.onmessage = () => { if (stream === connection) refresh(Boolean(!settings.querySelector('details') || (settings.querySelector('details[open]') && !editingSettings && !document.querySelector('.team-editor')))).catch(fail); };
  connection.onerror = () => { if (stream !== connection) return; ++generation; team = undefined; stream = undefined; for (const panel of Object.values(panels)) panel.replaceChildren(); settings.replaceChildren(saved); error.textContent = 'Team updates disconnected. Access may have changed. Reselect the team to reconnect.'; (Object.values(panels).find(panel => !panel.hidden) ?? panels.assistants).append(error); stream?.close(); };
  refresh(true).catch(fail);
});
window.addEventListener('pagehide', () => { ++generation; stream?.close(); stream = undefined; });
// However the control center opens (its button, the shortcut, a reload that restores it), the team list is filled.
window.addEventListener('control-center-activated', () => loadTeams().catch(fail));
document.querySelector('#openControlCenterButton').addEventListener('click', () => loadTeams().catch(fail));
