// Shared host team context. Personal Bob's views and settings are deliberately untouched.
import { api as request } from './api.js';
const api = (path, options = {}) => request(path, { ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
import { makeNode, makeButton } from './relay-ui.js';
import { registerContextView, setControlContext, showControlView } from './control-views.js';
import { renderTeamTelegram } from './control-team-telegram.js';
import { openConversation } from './control-center.js';

const panels = Object.fromEntries(['assistants', 'live', 'memory'].map(id => {
  const panel = makeNode('section', 'control-view team-control');
  panel.dataset.testid = `team-${id}-view`;
  panel.setAttribute('role', 'tabpanel');
  document.querySelector('#controlViews').append(panel);
  registerContextView(id, panel);
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
let team, stream, generation = 0, refreshGeneration = 0, editingSettings = false;
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
  const { clusters } = await api('/api/clusters');
  const options = [new Option(clusters.length ? 'Select a team' : 'No cluster yet: create one under Clusters', '')];
  for (const cluster of clusters) {
    const { teams } = await api(`/api/assistant-teams?clusterId=${encodeURIComponent(cluster.id)}`);
    for (const item of teams) options.push(new Option(cluster.name, item.id));
    if (!teams.length) options.push(new Option(`${cluster.name} — create team on this host`, `create:${cluster.id}`));
  }
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
  settings.replaceChildren(makeNode('h2', '', 'Shared team settings · personal Bob is separate'), error, saved);
  panels.assistants.append(makeNode('h2', '', 'Shared team assistants'), makeNode('p', '', `Host: ${readiness.host.name}`), tagged(makeNode('p', '', 'Pi only · browser profiles and compatible plugin skills require explicit host shares and role selection; MCP uses approved host connections.'), 'team-runtime'));
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
  const cards = makeNode('div', 'team-cards');
  for (const agent of agents.agents) {
    const card = tagged(makeNode('article', 'team-card'), 'team-agent-card'); card.dataset.role = agent.role; card.dataset.revision = String(team.revision);
    card.append(makeNode('h3', '', agent.profile.name), makeNode('p', '', agent.readiness.join(' · ') || 'Ready'));
    card.append(button('Configure', `team-configure-${agent.role}`, () => editAgent(agent, card, url)));
    cards.append(card);
  }
  panels.assistants.append(cards);
  const cardPager = tagged(makeNode('nav', 'team-pager'), 'team-cards-pager');
  panels.assistants.append(cardPager);
  let cardOffset = 0;
  const pageCards = () => {
    const mobile = matchMedia('(max-width: 760px)').matches;
    const size = mobile ? 1 : agents.agents.length;
    if (cardOffset >= agents.agents.length) cardOffset = 0;
    [...cards.children].forEach((card, index) => { card.hidden = index < cardOffset || index >= cardOffset + size; });
    cardPager.hidden = !mobile;
    const prev = button('Previous role', 'team-cards-prev', () => { cardOffset--; pageCards(); }); prev.disabled = cardOffset === 0;
    const next = button('Next role', 'team-cards-next', () => { cardOffset++; pageCards(); }); next.disabled = cardOffset + size >= agents.agents.length;
    cardPager.replaceChildren(prev, makeNode('span', '', `${cardOffset + 1}–${Math.min(cardOffset + size, agents.agents.length)} of ${agents.agents.length}`), next);
  };
  pageCards();
  const resizeCards = () => { if (cards.isConnected) pageCards(); else window.removeEventListener('resize', resizeCards); };
  window.addEventListener('resize', resizeCards);
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
async function editAgent(agent, card, url) {
  card.querySelector('.team-editor')?.remove();
  const editorGeneration = generation;
  const profile = agent.profile, form = makeNode('div', 'team-editor');
  const name = input(form, 'Name', 'team-agent-name', profile.name);
  const prompt = input(form, 'Role instructions', 'team-agent-prompt', profile.instructions, 'textarea');
  const provider = input(form, 'Pi provider', 'team-agent-provider', profile.executionSettings.provider);
  const model = input(form, 'Pi model', 'team-agent-model', profile.executionSettings.modelId);
  const reasoning = input(form, 'Reasoning', 'team-agent-reasoning', profile.executionSettings.reasoning);
  const terminal = input(form, 'Allow terminal', 'team-agent-terminal', '', 'checkbox'); terminal.checked = profile.allowTerminal;
  form.append(button('Save role', 'team-agent-save', async () => {
    if (!current(editorGeneration, url)) return;
    const updated = await api(`${url}/agents/${agent.role}`, { method: 'PUT', body: { expectedRevision: team.revision, name: name.value, instructions: prompt.value, allowTerminal: terminal.checked, executionSettings: { harnessId: 'pi', provider: provider.value, modelId: model.value, reasoning: reasoning.value } } });
    if (!current(editorGeneration, url)) return;
    team.revision = updated.revision;
    form.remove(); await refresh(true);
  })); card.append(form);
  const resourcePanel = makeNode('div'); form.append(resourcePanel);
  const resourcesUrl = `${url}/agents/${agent.role}`;
  const showResources = async () => {
    if (!current(editorGeneration, url)) return;
    const resources = await api(`${resourcesUrl}/resources`);
    if (!current(editorGeneration, url) || !form.isConnected) return;
    team.revision = Math.max(team.revision, resources.revision);
    resourcePanel.replaceChildren(makeNode('h4', '', 'Role uploads, browser profiles, plugins and approved MCP servers'));
    if (resources.ownerMcpServers) {
      const label = input(resourcePanel, 'New persistent team browser profile (human signs in through browser handoff)', 'team-browser-name', '');
      resourcePanel.append(button('Create team profile', 'team-browser-create', async () => {
        await api(`${url}/browser-profiles`, { method: 'POST', body: { expectedRevision: resources.revision, label: label.value } });
        await updateRevision(url, editorGeneration); await showResources();
      }));
    }
    for (const profile of resources.browserProfiles || []) {
      const enabled = input(resourcePanel, `Host browser profile ${profile.label} for this role`, 'team-browser-enabled', '', 'checkbox');
      enabled.checked = profile.selected;
      enabled.addEventListener('change', () => Promise.resolve().then(async () => {
        await api(`${resourcesUrl}/browser`, { method: 'PUT', body: { expectedRevision: resources.revision, profileId: enabled.checked ? profile.id : null } });
        await updateRevision(url, editorGeneration); await showResources();
      }).catch(fail));
    }
    for (const plugin of resources.ownerPlugins || []) {
      const shared = input(resourcePanel, `Share app-configured plugin ${plugin.name} with team`, 'team-plugin-share', '', 'checkbox'); shared.checked = plugin.shared;
      shared.addEventListener('change', () => Promise.resolve().then(async () => {
        await api(`${url}/plugin-shares/${encodeURIComponent(plugin.name)}`, { method: 'PUT', body: { expectedRevision: resources.revision, enabled: shared.checked } });
        await updateRevision(url, editorGeneration); await showResources();
      }).catch(fail));
    }
    for (const plugin of resources.plugins || []) {
      const enabled = input(resourcePanel, `${plugin.name} for this Pi role (${plugin.status})`, 'team-plugin-enabled', '', 'checkbox'); enabled.checked = plugin.enabled;
      enabled.addEventListener('change', () => Promise.resolve().then(async () => {
        const names = new Set(resources.plugins.filter(item => item.enabled).map(item => item.name));
        if (enabled.checked) names.add(plugin.name); else names.delete(plugin.name);
        await api(`${resourcesUrl}/plugins`, { method: 'PUT', body: { expectedRevision: resources.revision, names: [...names] } });
        await updateRevision(url, editorGeneration); await showResources();
      }).catch(fail));
    }
    for (const server of resources.ownerMcpServers || []) {
      const share = input(resourcePanel, `Share ${server.name} (${server.type}) with this cluster's team using the host account's local connection`, 'team-mcp-share', '', 'checkbox');
      share.checked = server.shared;
      share.addEventListener('change', () => Promise.resolve().then(async () => {
        await api(`${url}/mcp-shares/${encodeURIComponent(server.name)}`, { method: 'PUT', body: { expectedRevision: resources.revision, enabled: share.checked } });
        await updateRevision(url, editorGeneration); await showResources();
      }).catch(fail));
    }
    for (const server of resources.mcpServers) {
      const enabled = input(resourcePanel, `${server.name} (${server.type}, ${server.status}) for this role`, 'team-mcp-enabled', '', 'checkbox'); enabled.checked = server.enabled;
      enabled.addEventListener('change', () => Promise.resolve().then(async () => {
        const names = new Set(resources.mcpServers.filter(item => item.enabled).map(item => item.name));
        if (enabled.checked) names.add(server.name); else names.delete(server.name);
        await api(`${resourcesUrl}/resources`, { method: 'PUT', body: { expectedRevision: resources.revision, disabledSkills: resources.preferences.disabledSkills, mcpServerNames: [...names] } });
        await updateRevision(url, editorGeneration); await showResources();
      }).catch(fail));
    }
    const upload = input(resourcePanel, 'Upload file', 'team-file-upload', '', 'file');
    upload.addEventListener('change', () => Promise.resolve().then(async () => {
      const file = upload.files[0]; if (!file) return;
      const data = await fileData(file);
      if (!current(editorGeneration, url)) return;
      await api(`${resourcesUrl}/files`, { method: 'POST', body: { expectedRevision: resources.revision, name: file.name, data } });
      await updateRevision(url, editorGeneration); await showResources();
    }).catch(fail));
    const skillUpload = input(resourcePanel, 'Upload skill files (include SKILL.md)', 'team-skill-upload', '', 'file'); skillUpload.multiple = true;
    skillUpload.addEventListener('change', () => Promise.resolve().then(async () => {
      const files = await Promise.all([...skillUpload.files].map(async file => ({ relativePath: file.webkitRelativePath || file.name, data: await fileData(file) })));
      if (!current(editorGeneration, url)) return;
      await api(`${resourcesUrl}/skills`, { method: 'POST', body: { expectedRevision: resources.revision, files } }); await updateRevision(url, editorGeneration); await showResources();
    }).catch(fail));
    for (const file of resources.files) {
      const row = tagged(makeNode('p', '', file.path), 'team-file-row');
      row.append(button('Delete', 'team-file-delete', async () => { await api(`${resourcesUrl}/files?path=${encodeURIComponent(file.path)}`, { method: 'DELETE', body: { expectedRevision: resources.revision } }); await updateRevision(url, editorGeneration); await showResources(); })); resourcePanel.append(row);
    }
    for (const skill of resources.skills) {
      const enabled = input(resourcePanel, skill.name, 'team-skill-enabled', '', 'checkbox'); enabled.checked = !resources.preferences.disabledSkills.includes(skill.name);
      enabled.addEventListener('change', () => Promise.resolve().then(async () => {
        const disabledSkills = new Set(resources.preferences.disabledSkills); if (enabled.checked) disabledSkills.delete(skill.name); else disabledSkills.add(skill.name);
        await api(`${resourcesUrl}/resources`, { method: 'PUT', body: { expectedRevision: resources.revision, disabledSkills: [...disabledSkills] } }); await updateRevision(url, editorGeneration); await showResources();
      }).catch(fail));
      resourcePanel.append(button('Delete skill', 'team-skill-delete', async () => { await api(`${resourcesUrl}/skills/${skill.id}`, { method: 'DELETE', body: { expectedRevision: resources.revision } }); await updateRevision(url, editorGeneration); await showResources(); }));
    }
  };
  await showResources();
}
const fileData = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
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
      select.replaceChildren(); await loadTeams(); if (mine !== generation) return; select.value = result.team.id; select.dispatchEvent(new Event('change'));
    }).catch(fail); return;
  }
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
