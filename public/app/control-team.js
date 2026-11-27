// Shared host team workspace: first-class Teams sidebar, Chief Chat & Activity, Members & Work, Memory CRUD, Channels & Settings.
import { api as request } from './api.js';
import { makeNode, makeButton } from './relay-ui.js';
import { currentControlView, registerContextView, setControlContext, showControlView } from './control-views.js';
import { renderTeamTelegram } from './control-team-telegram.js';
import { createTeamWork } from './control-team-work.js';
import { openExecutionDetailModal, openMemberConnectionsModal } from './control-team-modals.js';
import { openNewTeamWizard } from './control-team-wizard.js';
import { openConversation } from './control-center.js';
import { confirmAction, toast } from './shell.js';
import { setMobileView } from './layout.js';

const api = (path, options = {}) => request(path, { ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
const tagged = (node, id) => { node.dataset.testid = id; return node; };
const clip = (s, n) => (!s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s);

const panels = Object.fromEntries(['assistants', 'live', 'memory'].map(id => {
  const panel = makeNode('section', 'control-view team-control');
  panel.dataset.testid = `team-${id}-view`;
  panel.setAttribute('role', 'tabpanel');
  document.querySelector('#controlViews').append(panel);
  registerContextView(id, panel);
  return [id, panel];
}));
const settingsWorkspacePanel = makeNode('section', 'control-view team-control team-settings-workspace');
settingsWorkspacePanel.dataset.testid = 'team-settings-view';
settingsWorkspacePanel.hidden = true;
document.querySelector('#controlViews').append(settingsWorkspacePanel);

const settingsPanel = document.querySelector('#settingsPanel-account');
const select = tagged(makeNode('select'), 'team-select');
select.setAttribute('aria-label', 'Shared team');
const error = tagged(makeNode('p', 'team-error-inline'), 'team-error'); error.setAttribute('role', 'alert');
const saved = makeNode('p', 'team-status-inline'); saved.setAttribute('role', 'status');

// Legacy top selector kept hidden on desktop (bob-page.css) & synced for mobile/tests.
const contextLabel = makeNode('label', 'team-context-label', 'Context ');
const newTeamButtons = makeNode('span', 'team-new-buttons');
contextLabel.append(select, newTeamButtons);
document.querySelector('#controlTabs').before(contextLabel);

// First-class Teams section for desktop sidebar (moved into #workspaceSide by bob-page.js).
const sidebarSection = makeNode('section', 'team-sidebar-section');
sidebarSection.dataset.testid = 'team-sidebar-section';
const sidebarHead = makeNode('div', 'team-sidebar-head');
sidebarHead.append(makeNode('span', 'team-sidebar-title', 'TEAMS'));
const sidebarList = makeNode('div', 'team-sidebar-list');
sidebarList.dataset.testid = 'team-sidebar-list';
const sidebarNewBtn = makeButton('+ New team with Chief…', 'team-sidebar-new', () => Promise.resolve().then(launchWizard).catch(fail));
sidebarNewBtn.className = 'ghost compact team-sidebar-new';
sidebarSection.append(sidebarHead, sidebarList, sidebarNewBtn);
document.querySelector('#controlTabs').before(sidebarSection);

// Persistent 4-tab bar inside the Team Workspace (always visible when a team is selected).
const workspaceBar = makeNode('nav', 'team-workspace-tabs');
workspaceBar.dataset.testid = 'team-workspace-tabs';
workspaceBar.hidden = true;
const TAB_DEFS = [
  ['live', 'Chief Chat & Activity'],
  ['assistants', 'Members & Work'],
  ['memory', 'Memory'],
  ['settings', 'Channels & Settings'],
];
let activeTeamTab = 'live';
const tabButtons = new Map();
for (const [id, label] of TAB_DEFS) {
  const btn = makeNode('button', 'team-ws-tab', label);
  btn.type = 'button';
  btn.dataset.testid = `team-tab-${id}`;
  const badge = makeNode('span', 'team-tab-badge');
  badge.hidden = true;
  btn.append(badge);
  btn.addEventListener('click', () => switchTeamTab(id));
  tabButtons.set(id, { btn, badge });
  workspaceBar.append(btn);
}
document.querySelector('#controlViews').prepend(workspaceBar);
const gone = tagged(makeNode('p', 'team-error-inline team-gone', 'This team no longer exists. Updates have stopped.'), 'team-gone');
gone.setAttribute('role', 'status');
gone.hidden = true;
workspaceBar.after(gone);

const button = (text, id, fn) => makeButton(text, id, () => Promise.resolve().then(fn).catch(fail));
const backToAssistants = button('← Back to Personal Bob', 'team-back-to-assistants', () => exitTeamContext());
backToAssistants.className = 'ghost compact team-back-btn';
backToAssistants.hidden = true;
workspaceBar.append(backToAssistants);

const mobileEntry = button('Teams', 'team-phone-open', async () => { await loadTeams(true); showControlView('assistants'); });
mobileEntry.classList.add('team-phone-entry');
document.querySelector('.control-chat-head')?.append(mobileEntry);
window.addEventListener('control-view-changed', event => {
  document.body.classList.toggle('team-phone-live', event.detail.id === 'live');
  if (select.value && ['live', 'assistants', 'memory'].includes(event.detail.id) && activeTeamTab !== 'settings') {
    activeTeamTab = event.detail.id;
    syncWorkspaceTabUi();
  }
});
const mobileSelect = tagged(makeNode('select'), 'team-phone-select');
mobileSelect.setAttribute('aria-label', 'Shared team on phone');
mobileSelect.addEventListener('change', () => { select.value = mobileSelect.value; select.dispatchEvent(new Event('change')); });
const mobileContext = makeNode('label', 'team-phone-context', 'Team '); mobileContext.append(mobileSelect);
document.querySelector('#controlViews').prepend(mobileContext);

const settingsMirror = makeNode('section', 'team-control team-settings-area');
settingsMirror.append(makeNode('h2', '', 'Shared team settings · personal Bob is separate'));
settingsPanel.append(settingsMirror);

let team, stream, work, hubTeams = new Map(), knownClusters = [], knownUnreachable = [];
let generation = 0, refreshGeneration = 0, editingSettings = false;
let latestAgents = null, latestRequests = [], selectedMemberRole = null;
let selectedMemoryKey = null, memoryDirty = false;

const base = () => `/api/assistant-teams/${encodeURIComponent(select.value)}`;
const current = (mine, url) => mine === generation && select.value && base() === url;
const fail = e => {
  error.textContent = e.message;
  toast.error(e.message);
};

function syncWorkspaceTabUi() {
  const inTeam = Boolean(select.value);
  workspaceBar.hidden = !inTeam;
  backToAssistants.hidden = !inTeam;
  settingsWorkspacePanel.hidden = !inTeam || activeTeamTab !== 'settings';
  if (inTeam && activeTeamTab === 'settings') {
    for (const panel of Object.values(panels)) panel.hidden = true;
  }
  for (const [id, { btn }] of tabButtons) {
    btn.classList.toggle('active', activeTeamTab === id);
    btn.setAttribute('aria-selected', String(activeTeamTab === id));
  }
}

function switchTeamTab(id) {
  activeTeamTab = id;
  if (id === 'settings') {
    syncWorkspaceTabUi();
  } else {
    settingsWorkspacePanel.hidden = true;
    showControlView(id);
    syncWorkspaceTabUi();
  }
}

function exitTeamContext() {
  if (!select.value) return;
  select.value = '';
  select.dispatchEvent(new Event('change'));
}

function selectTeamById(teamId, preferredTab = 'live') {
  const item = hubTeams.get(teamId);
  const val = item ? (item.local ? item.id : `remote:${item.id}`) : teamId;
  if (!document.body.classList.contains('view-control')) setMobileView('control');
  if (select.value !== val) {
    select.value = val;
    select.dispatchEvent(new Event('change'));
  }
  switchTeamTab(preferredTab);
}

function renderSidebarTeams() {
  sidebarList.replaceChildren();
  const activeId = select.value.startsWith('remote:') ? select.value.slice(7) : select.value;
  if (!hubTeams.size) {
    sidebarList.append(makeNode('p', 'team-sidebar-empty', 'No teams yet'));
    return;
  }
  for (const item of hubTeams.values()) {
    const pill = makeNode('button', `team-sidebar-pill${activeId === item.id ? ' active' : ''}`);
    pill.type = 'button';
    pill.dataset.testid = `team-sidebar-item-${item.id}`;
    const dot = makeNode('span', 'team-live-dot');
    const copy = makeNode('span', 'team-sidebar-copy');
    const chief = item.members.find(m => m.coordinator);
    copy.append(
      makeNode('strong', '', item.name || item.clusterName),
      makeNode('small', '', chief ? `Chief: ${chief.name || `/${chief.role}`}${item.local ? '' : ` · ${item.hostName}`}` : (item.local ? item.hostName : `on ${item.hostName}`)),
    );
    pill.append(dot, copy);
    pill.addEventListener('click', () => selectTeamById(item.id, activeId === item.id ? activeTeamTab : 'live'));
    sidebarList.append(pill);
  }
}

const syncMobile = () => {
  mobileSelect.replaceChildren(...[...select.options].map(option => new Option(option.text, option.value)));
  mobileSelect.value = select.value;
  renderSidebarTeams();
};

function input(parent, label, id, value, type = 'text') {
  const wrapper = makeNode('label', 'team-field');
  wrapper.append(makeNode('span', '', label));
  const field = tagged(makeNode(type === 'textarea' ? 'textarea' : 'input'), id);
  if (type !== 'textarea') field.type = type;
  field.value = value ?? '';
  wrapper.append(field);
  parent.append(wrapper);
  return field;
}

const deleteButton = (teamId, name) => {
  const btn = button('Delete team', 'team-delete', async () => {
    if (!await confirmAction({ eyebrow: 'Assistant team', title: `Delete "${name}"?`, message: "Its members stay as assistants; the team's conversations, memory and requests are removed.", confirmLabel: 'Delete team', destructive: true })) return;
    await api(`/api/team-hub/${encodeURIComponent(teamId)}`, { method: 'DELETE' });
    // Leave first: reloading drops the deleted team's option and clears the picker without a change event,
    // which would leave its view and polling open.
    exitTeamContext();
    await loadTeams(true);
    toast(`Deleted ${name}`);
  });
  btn.className = 'ghost compact danger';
  return btn;
};

let teamsLoaded = false, teamsLoadPromise = null;

function launchWizard() {
  if (document.querySelector('[data-testid="team-wizard-dialog"]')) return;
  openNewTeamWizard({
    clusters: knownClusters,
    teams: [...hubTeams.values()],
    unreachable: knownUnreachable,
    loadInitial: teamsLoaded ? null : async () => {
      await loadTeams(false);
      return { clusters: knownClusters, teams: [...hubTeams.values()], unreachable: knownUnreachable };
    },
    onTeamCreated: () => { void loadTeams(true); },
    onLaunch: async newTeamId => {
      await loadTeams(true);
      if (newTeamId) selectTeamById(newTeamId, 'live');
    },
  });
}

async function loadTeams(force = false, { fresh = force } = {}) {
  if (!force && teamsLoaded) return;
  if (!force && teamsLoadPromise) return teamsLoadPromise;
  const run = (async () => {
    const previous = select.value;
    const [{ clusters }, { teams, unreachable }] = await Promise.all([
      api('/api/clusters'),
      api(fresh ? '/api/team-hub?fresh=1' : '/api/team-hub'),
    ]);
    knownClusters = clusters ?? [];
    knownUnreachable = unreachable ?? [];
    hubTeams = new Map((teams ?? []).map(item => [item.id, item]));
    teamsLoaded = true;
    const options = [new Option(teams.length || clusters.length ? 'Select a team' : 'No cluster yet', '')];
    for (const item of teams) {
      const label = item.name || item.clusterName;
      options.push(new Option(item.local ? label : `${label} — on ${item.hostName}`, item.local ? item.id : `remote:${item.id}`));
    }
    select.replaceChildren(...options);
    if (previous && [...select.options].some(o => o.value === previous)) select.value = previous;
    const creatable = clusters.filter(cluster => !teams.some(item => item.clusterId === cluster.id) && !unreachable.includes(cluster.id));
    newTeamButtons.replaceChildren(...creatable.map(cluster => button(`+ New team (${cluster.name})`, 'team-new', () => launchWizard())));
    syncMobile();
  })();
  teamsLoadPromise = run.finally(() => { if (teamsLoadPromise === run) teamsLoadPromise = null; });
  return teamsLoadPromise;
}

function updateLiveBadges() {
  const runningRoles = new Set();
  for (const req of latestRequests) {
    if (['running', 'queued'].includes(req.state)) {
      for (const a of req.assignments) if (['running', 'queued', 'accepted'].includes(a.state)) runningRoles.add(a.role);
    }
  }
  const mBadge = tabButtons.get('assistants')?.badge;
  if (mBadge) {
    mBadge.textContent = runningRoles.size ? `${runningRoles.size} live` : String(latestAgents?.agents?.length ?? 0);
    mBadge.classList.toggle('is-live', runningRoles.size > 0);
    mBadge.hidden = !latestAgents?.agents?.length && !runningRoles.size;
  }
}

function memberWorkGroups(role) {
  const active = [];
  const past = [];
  for (const req of latestRequests) {
    for (const part of req.assignments) {
      if (part.role !== role) continue;
      const entry = { req, part };
      if (['running', 'queued', 'accepted', 'waiting_for_human'].includes(part.state)) active.push(entry);
      else past.push(entry);
    }
  }
  return { active, past };
}

async function renderMembersWorkspace(url, agents, readiness) {
  const mine = generation;
  const { assistants } = await api(`${url}/available-assistants`);
  if (!current(mine, url)) return;
  const rows = agents.agents.map(agent => ({ role: agent.role, assistantId: agent.assistantId, profile: agent.profile, readiness: agent.readiness, coordinator: agent.coordinator }));
  if (!selectedMemberRole || !rows.some(r => r.role === selectedMemberRole)) selectedMemberRole = rows.find(r => r.coordinator)?.role ?? rows[0]?.role ?? null;

  panels.assistants.replaceChildren();
  const split = makeNode('div', 'team-split');
  const rail = makeNode('aside', 'team-rail');
  const detail = makeNode('div', 'team-detail');

  rail.append(makeNode('p', 'team-rail-hint', 'Select a member to inspect live work, past tasks & service connections:'));
  for (const row of rows) {
    const { active, past } = memberWorkGroups(row.role);
    const btn = makeNode('button', `team-member-item${selectedMemberRole === row.role ? ' selected' : ''}`);
    btn.type = 'button';
    btn.dataset.testid = `team-member-select-${row.role}`;
    const top = makeNode('div', 'team-member-item-top');
    top.append(
      makeNode('span', `team-live-dot${active.length ? ' working' : ''}`),
      makeNode('strong', '', row.profile?.name ?? row.role),
      makeNode('code', '', `/${row.role}`),
      ...(row.coordinator ? [makeNode('span', 'team-pill state-done', 'Chief')] : []),
    );
    const statusText = active.length
      ? `Working: ${clip(active[0].part.prompt || active[0].req.text, 64)}`
      : `Idle · ${past.length} past task${past.length === 1 ? '' : 's'} · ${row.readiness.length ? 'needs attention' : 'ready'}`;
    btn.append(top, makeNode('small', active.length ? 'team-working-line' : 'team-muted', statusText));
    btn.addEventListener('click', () => { selectedMemberRole = row.role; drawMemberDetail(detail, url, rows, readiness); for (const el of rail.querySelectorAll('.team-member-item')) el.classList.toggle('selected', el === btn); });
    rail.append(btn);
  }

  drawMemberDetail(detail, url, rows, readiness);
  split.append(rail, detail);
  panels.assistants.append(split);

  // Collapsible Roster Management (keeps existing add/remove/rename/coordinator flows).
  const rosterDetails = makeNode('details', 'team-roster-manage');
  rosterDetails.append(makeNode('summary', '', `Manage Roster (${rows.length} members)`));
  let coordinator = agents.coordinatorRole;
  const saveRoster = async () => {
    const result = await api(`${url}/members`, { method: 'PUT', body: { expectedRevision: team.revision, coordinatorRole: rows.some(row => row.role === coordinator) ? coordinator : null, members: rows.map(({ role, assistantId }) => ({ role, assistantId })) } });
    team.revision = result.revision; error.textContent = ''; await refresh(true);
  };
  const cards = tagged(makeNode('div', 'team-cards'), 'team-members');
  for (const row of rows) {
    const card = tagged(makeNode('article', 'team-card'), 'team-agent-card'); card.dataset.role = row.role;
    card.append(makeNode('h4', '', `/${row.role} · ${row.profile?.name ?? 'deleted assistant'}${row.role === coordinator ? ' · Chief' : ''}`));
    const roleField = input(card, 'Role (Telegram command)', 'team-member-role', row.role);
    roleField.addEventListener('change', () => { if (coordinator === row.role) coordinator = roleField.value.trim(); row.role = roleField.value.trim(); });
    const actions = makeNode('div', 'team-row-actions');
    if (row.role !== coordinator) actions.append(button('Make Chief', 'team-member-coordinator', () => { coordinator = row.role; return saveRoster(); }));
    actions.append(button('Remove', 'team-member-remove', () => { rows.splice(rows.indexOf(row), 1); return saveRoster(); }));
    card.append(actions);
    cards.append(card);
  }
  const add = makeNode('div', 'team-settings');
  const choices = assistants.filter(item => !item.inTeam);
  const pick = tagged(makeNode('select'), 'team-member-pick'); pick.setAttribute('aria-label', 'Assistant to add');
  pick.replaceChildren(...(choices.length ? choices.map(item => new Option(`${item.name} — ${item.uses.join(', ') || 'no extra resources'}`, item.id)) : [new Option('No other assistants on this host', '')]));
  const newRole = input(add, 'Role', 'team-member-new-role', '');
  add.prepend(pick);
  add.append(button('Add to team', 'team-member-add', () => {
    if (!pick.value) throw new Error('Create an assistant on this host first.');
    if (!newRole.value.trim()) throw new Error('Give the new member a role, for example finance.');
    rows.push({ role: newRole.value.trim(), assistantId: pick.value });
    return saveRoster();
  }), button('Save roles', 'team-members-save', saveRoster));
  rosterDetails.append(cards, add);
  panels.assistants.append(rosterDetails);
}

function drawMemberDetail(container, url, rows, readiness) {
  container.replaceChildren();
  const member = rows.find(r => r.role === selectedMemberRole);
  if (!member) { container.append(makeNode('p', 'team-muted', 'No members in this team yet. Use Manage Roster or run the Chief Setup Wizard.')); return; }

  const { active, past } = memberWorkGroups(member.role);
  const head = makeNode('div', 'team-detail-head');
  const headCopy = makeNode('div', '');
  const titleRow = makeNode('div', 'team-detail-title-row');
  titleRow.append(makeNode('h2', '', member.profile?.name ?? member.role), makeNode('code', 'team-inline-code', `/${member.role}`), ...(member.coordinator ? [makeNode('span', 'team-pill state-done', 'Chief')] : []));
  headCopy.append(titleRow, makeNode('p', 'team-muted', `${(member.profile?.uses ?? []).join(' · ') || 'No extra services attached'} · Host: ${readiness.host.name}`));
  const memBtn = makeButton(`View /${member.role} memory →`, `team-member-view-memory-${member.role}`, () => {
    selectedMemoryKey = `member:${member.role}:playbook`;
    switchTeamTab('memory');
  });
  memBtn.className = 'ghost compact';
  head.append(headCopy, memBtn);
  container.append(head);

  if (member.readiness.length) {
    container.append(makeNode('p', 'team-error-inline', `Readiness: ${member.readiness.join(' · ')}`));
  }

  // Currently Working On
  const activeSec = makeNode('section', 'team-detail-section');
  activeSec.append(makeNode('span', 'team-section-eyebrow', 'CURRENTLY WORKING ON'));
  if (!active.length) {
    activeSec.append(makeNode('div', 'team-empty-box', 'Idle — no task running right now.'));
  } else {
    for (const { req, part } of active) {
      const box = makeNode('article', 'team-work-card is-active');
      const top = makeNode('div', 'team-row-head');
      top.append(makeNode('span', `team-pill state-${part.state}`, part.state.replaceAll('_', ' ')), makeNode('code', 'team-short-id', `#${req.shortId}`));
      const actions = makeNode('div', 'team-row-actions');
      if (part.id) {
        const inspect = makeButton('Inspect live execution →', `team-member-inspect-${part.id}`, () => void openExecutionDetailModal(team.id, part.id, { openConversation }));
        inspect.className = 'primary compact';
        actions.append(inspect);
      }
      const stopBtn = makeButton('Stop', `team-member-stop-${req.shortId}`, async () => {
        await api(`/api/team-hub/${encodeURIComponent(team.id)}/cancel`, { method: 'POST', body: { ref: req.shortId } });
        await work?.refresh();
      });
      stopBtn.className = 'ghost compact';
      actions.append(stopBtn);
      top.append(actions);
      box.append(top, makeNode('p', '', clip(part.prompt || req.text, 300)));
      activeSec.append(box);
    }
  }
  container.append(activeSec);

  // Service Connections (stays inside team!)
  const connSec = makeNode('section', 'team-detail-section');
  connSec.append(makeNode('span', 'team-section-eyebrow', `SERVICE CONNECTIONS (STAYS INSIDE ${team.name || 'THIS TEAM'})`));
  const connBox = makeNode('div', 'team-conn-row');
  const connInfo = makeNode('div', '');
  connInfo.append(makeNode('strong', '', 'Secrets, MCP Servers, Skills & Live Browser Logins'), makeNode('p', 'team-muted', (member.profile?.uses ?? []).join(' · ') || 'No services connected yet'));
  const connBtn = makeButton('Connect / Configure', `team-member-connect-${member.role}`, () => {
    void openMemberConnectionsModal(team.id, member.role, { onSaved: () => void refresh(true) });
  });
  connBtn.className = 'primary compact';
  connBox.append(connInfo, connBtn);
  connSec.append(connBox);
  container.append(connSec);

  // Past Work
  const pastSec = makeNode('section', 'team-detail-section');
  pastSec.append(makeNode('span', 'team-section-eyebrow', `PAST WORK (${past.length})`));
  if (!past.length) {
    pastSec.append(makeNode('div', 'team-empty-box', 'No completed tasks yet for this role.'));
  } else {
    for (const { req, part } of past.slice(0, 15)) {
      const card = makeNode('article', 'team-work-card');
      const top = makeNode('div', 'team-row-head');
      const meta = makeNode('div', 'team-row-meta');
      meta.append(makeNode('code', 'team-short-id', `#${req.shortId}`), makeNode('span', `team-pill state-${part.state}`, part.state), ...(part.delegated ? [makeNode('span', 'team-muted', 'from Chief')] : []));
      top.append(meta);
      if (part.id) {
        const inspect = makeButton('Inspect execution →', `team-member-past-inspect-${part.id}`, () => void openExecutionDetailModal(team.id, part.id, { openConversation }));
        inspect.className = 'ghost compact';
        top.append(inspect);
      }
      card.append(top, makeNode('p', 'team-work-prompt', clip(part.prompt || req.text, 220)));
      if (part.result) card.append(makeNode('p', 'team-muted', clip(part.result, 240)));
      pastSec.append(card);
    }
  }
  container.append(pastSec);
}

async function renderMemoryWorkspace(url, agents) {
  const mine = generation;
  const [topicsRes, changesRes, statusRes] = await Promise.all([
    api(`${url}/memory/topics?scope=all&limit=100`),
    api(`${url}/memory/changes?limit=40`),
    api(`${url}/memory/status`),
  ]);
  if (!current(mine, url)) return;

  const topics = topicsRes.topics ?? [];
  const changes = changesRes.changes ?? [];
  const badge = tabButtons.get('memory')?.badge;
  if (badge) { badge.textContent = String(topics.length); badge.hidden = !topics.length; }

  panels.memory.replaceChildren();
  const collective = topics.filter(t => t.scope === 'team');
  const memberTopics = topics.filter(t => t.scope === 'member');
  const roles = (agents?.agents ?? []).map(a => a.role);

  const split = makeNode('div', 'team-split');
  const rail = makeNode('aside', 'team-rail');
  const editorPane = makeNode('div', 'team-detail');

  const railTop = makeNode('div', 'team-row-head');
  railTop.append(makeNode('strong', '', 'Memory Topics'));
  const newBtn = makeButton('+ New topic', 'team-memory-new', () => openMemoryEditor(editorPane, url, null, roles));
  newBtn.className = 'primary compact';
  railTop.append(newBtn);
  rail.append(railTop);

  const keyOf = t => `${t.scope}:${t.role ?? ''}:${t.name}`;
  if (!selectedMemoryKey || (!topics.some(t => keyOf(t) === selectedMemoryKey) && !selectedMemoryKey.startsWith('new:'))) {
    selectedMemoryKey = topics[0] ? keyOf(topics[0]) : null;
  }

  const addGroup = (title, items) => {
    rail.append(makeNode('span', 'team-section-eyebrow', title));
    if (!items.length) { rail.append(makeNode('p', 'team-muted', 'None yet')); return; }
    for (const item of items) {
      const k = keyOf(item);
      const btn = makeNode('button', `team-member-item${selectedMemoryKey === k ? ' selected' : ''}`);
      btn.type = 'button';
      btn.dataset.testid = `team-memory-item-${item.name}`;
      const top = makeNode('div', 'team-member-item-top');
      top.append(makeNode('strong', '', item.name), ...(item.role ? [makeNode('code', '', `/${item.role}`)] : [makeNode('span', 'team-pill', 'team')]), makeNode('span', 'team-muted', `v${item.revision}`));
      btn.append(top, makeNode('small', 'team-muted', clip(item.description, 80)));
      btn.addEventListener('click', () => {
        selectedMemoryKey = k;
        for (const el of rail.querySelectorAll('.team-member-item')) el.classList.toggle('selected', el === btn);
        void openMemoryEditor(editorPane, url, item, roles);
      });
      rail.append(btn);
    }
  };

  addGroup(`TEAM COLLECTIVE MEMORY (${collective.length})`, collective);
  addGroup(`MEMBER MEMORY BY ROLE (${memberTopics.length})`, memberTopics);

  const chosen = topics.find(t => keyOf(t) === selectedMemoryKey) ?? null;
  if (chosen) void openMemoryEditor(editorPane, url, chosen, roles);
  else editorPane.append(makeNode('div', 'team-empty-box', 'Select a memory topic on the left, or click + New topic to create collective team memory or role-specific memory.'));

  split.append(rail, editorPane);
  panels.memory.append(split);

  const attention = (statusRes.learning ?? []).filter(entry => ['waiting', 'decision_unavailable', 'writer_unavailable', 'memory_failed', 'file_pending'].includes(entry.status));
  const learning = tagged(makeNode('p', 'team-muted team-learning-line'), 'team-learning');
  learning.textContent = attention.length ? `Memory learning: ${attention.map(e => `${e.message_id}: ${e.status.replaceAll('_', ' ')}`).join(' · ')}` : 'Memory learning: Chief updates collective team memory on reviews; specialists maintain their own role memory.';
  panels.memory.append(learning);

  const changesDet = makeNode('details', 'team-changes-details');
  changesDet.append(tagged(makeNode('summary', '', `Recent Memory Changes (${changes.length})`), 'team-changes-toggle'));
  const changesList = makeNode('div', 'team-work-list');
  for (const ch of changes.slice(0, 25)) {
    const rec = makeNode('article', 'team-record');
    const top = makeNode('div', 'team-row-head');
    const action = ch.after_text === null ? 'deleted' : ch.before_text === null ? 'created' : 'updated';
    top.append(makeNode('strong', '', `${ch.topic} ${ch.role ? `(/${ch.role})` : '(team)'} · ${action} v${ch.revision}`), makeNode('span', 'team-muted', `${ch.actor} · ${ch.created_at}`));
    const revBtn = button('Revert', `team-memory-revert-${ch.id}`, async () => {
      await api(`${url}/memory/changes/${ch.id}/revert`, { method: 'POST', body: { expectedRevision: ch.revision } });
      toast(`Reverted ${ch.topic}`);
      await renderMemoryWorkspace(url, agents);
    });
    revBtn.className = 'ghost compact';
    rec.append(top, revBtn);
    changesList.append(rec);
  }
  changesDet.append(changesList);
  panels.memory.append(changesDet);
}

async function openMemoryEditor(pane, url, topicItem, roles) {
  memoryDirty = false;
  pane.replaceChildren(makeNode('p', 'team-muted', 'Loading topic…'));
  let loaded = { text: '', revision: 0, description: '', body: '' };
  if (topicItem) {
    const qs = topicItem.role ? `?role=${encodeURIComponent(topicItem.role)}` : '';
    loaded = await api(`${url}/memory/topics/${encodeURIComponent(topicItem.name)}${qs}`);
  }
  const editor = makeNode('div', 'team-editor team-memory-crud');
  const isNew = !topicItem;
  editor.append(makeNode('h3', '', isNew ? 'New Memory Topic' : `${topicItem.name} ${topicItem.role ? `(/${topicItem.role})` : '(Team Collective)'} · rev ${loaded.revision}`));

  const scopeWrap = makeNode('label', 'team-field');
  scopeWrap.append(makeNode('span', '', 'Scope'));
  const scopeSelect = document.createElement('select');
  scopeSelect.dataset.testid = 'team-memory-scope';
  scopeSelect.append(new Option('Team Collective Memory (shared by all roles)', 'team:'));
  for (const role of roles) scopeSelect.append(new Option(`Member Memory · /${role} only`, `member:${role}`));
  scopeSelect.value = topicItem?.role ? `member:${topicItem.role}` : 'team:';
  scopeSelect.disabled = !isNew;
  scopeWrap.append(scopeSelect);
  editor.append(scopeWrap);

  const name = input(editor, 'Topic slug (lowercase letters, digits, hyphens)', 'team-memory-name', topicItem?.name ?? '');
  name.disabled = !isNew;
  const description = input(editor, 'Description', 'team-memory-description', loaded.description || (isNew ? '' : topicItem.name));
  const body = input(editor, 'Markdown body', 'team-memory-body', loaded.body || '', 'textarea');
  body.rows = 12;
  for (const el of [name, description, body]) el.addEventListener('input', () => { memoryDirty = true; });

  const actions = makeNode('div', 'team-row-actions');
  const saveBtn = button('Save memory', 'team-memory-save', async () => {
    const [scope, role] = scopeSelect.value.split(':');
    const slug = name.value.trim().toLowerCase();
    if (!slug) throw new Error('Enter a topic slug, e.g. playbook or billing-rules.');
    await api(`${url}/memory/topics/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      body: {
        expectedRevision: loaded.revision,
        description: description.value.trim() || slug,
        body: body.value.trim(),
        sourceMessageIds: [],
        scope,
        ...(scope === 'member' ? { role } : {}),
      },
    });
    memoryDirty = false;
    selectedMemoryKey = `${scope}:${role || ''}:${slug}`;
    toast(`Saved memory topic "${slug}"`);
    await renderMemoryWorkspace(url, latestAgents);
  });
  saveBtn.className = 'primary compact';
  actions.append(saveBtn);

  if (!isNew) {
    const delBtn = button('Delete topic', 'team-memory-delete', async () => {
      if (!await confirmAction({ eyebrow: 'Team memory', title: `Delete "${topicItem.name}"?`, message: 'The topic file will be removed, and the deletion is recorded in Recent Memory Changes so you can revert it later.', confirmLabel: 'Delete topic', destructive: true })) return;
      await api(`${url}/memory/topics/${encodeURIComponent(topicItem.name)}`, {
        method: 'DELETE',
        body: { expectedRevision: loaded.revision, ...(topicItem.role ? { role: topicItem.role } : {}) },
      });
      memoryDirty = false;
      selectedMemoryKey = null;
      toast(`Deleted "${topicItem.name}"`);
      await renderMemoryWorkspace(url, latestAgents);
    });
    delBtn.className = 'ghost compact danger';
    actions.append(delBtn);
  }
  editor.append(actions);
  pane.replaceChildren(editor);
}

async function renderSettingsWorkspace(url, readiness) {
  const mine = generation;
  let catalogRes = null;
  try { catalogRes = await api(`${url}/catalog`); } catch { /* optional */ }
  if (!current(mine, url)) return;

  settingsWorkspacePanel.replaceChildren();
  const wrap = makeNode('div', 'team-settings-stack');
  wrap.append(makeNode('h2', '', 'Channels & Team Settings'), error, saved);

  // Core Team Settings + Personal Bob Integration + Voice Engine
  const coreCard = makeNode('section', 'team-card');
  coreCard.append(makeNode('h3', '', 'Identity, Bob Integration & Thresholds'));
  const nameField = input(coreCard, 'Team Name', 'team-name-input', team.name || hubTeams.get(team.id)?.clusterName || '');
  const bobRow = makeNode('label', 'team-check-row');
  const bobBox = document.createElement('input');
  bobBox.type = 'checkbox';
  bobBox.checked = team.settings.allowBob !== false;
  bobBox.dataset.testid = 'team-allow-bob';
  bobRow.append(bobBox, makeNode('span', '', `Allow Personal Bob on ${readiness.host.name} to interact with this team's Chief`));
  coreCard.append(bobRow);

  const thresholds = makeNode('div', 'team-settings');
  const ask = input(thresholds, 'Ask (%)', 'team-ask', Math.round(team.settings.askThreshold * 100), 'number');
  const act = input(thresholds, 'Act (%)', 'team-act', Math.round(team.settings.actThreshold * 100), 'number');
  for (const field of [nameField, ask, act]) field.addEventListener('input', () => { editingSettings = true; });
  coreCard.append(thresholds);

  // Voice Briefs Engine (Kokoro vs ElevenLabs)
  coreCard.append(makeNode('h4', '', 'Voice Briefs Engine'));
  const voiceBar = makeNode('div', 'team-inline-bar');
  const voiceProvider = document.createElement('select');
  voiceProvider.dataset.testid = 'team-voice-provider';
  voiceProvider.append(
    new Option(`Joint Bob Local Voice (Kokoro)${catalogRes?.voice?.local?.installed ? ' · Ready' : ''}`, 'kokoro'),
    new Option('ElevenLabs (cloud voice)', 'elevenlabs'),
  );
  voiceProvider.value = team.settings.voiceProvider || 'kokoro';
  const kokoroVoice = document.createElement('select');
  kokoroVoice.dataset.testid = 'team-kokoro-voice';
  for (const v of catalogRes?.voice?.kokoroVoices ?? [{ id: 'af_heart', label: 'Heart · American, female' }]) {
    kokoroVoice.append(new Option(v.label, v.id));
  }
  kokoroVoice.value = team.settings.kokoroVoice || 'af_heart';
  const syncVoice = () => { kokoroVoice.hidden = voiceProvider.value !== 'kokoro'; };
  voiceProvider.addEventListener('change', () => { editingSettings = true; syncVoice(); });
  syncVoice();
  voiceBar.append(voiceProvider, kokoroVoice);
  coreCard.append(voiceBar);

  const saveBtn = button('Save team settings', 'team-settings-save', async () => {
    const a = Number(ask.value), b = Number(act.value);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > 100 || a >= b) throw new Error('Ask must be below Act (0–100%).');
    const updated = await api(`${url}/settings`, {
      method: 'PUT',
      body: {
        expectedRevision: team.revision,
        name: nameField.value.trim() || null,
        settings: {
          askThreshold: a / 100,
          actThreshold: b / 100,
          allowBob: bobBox.checked,
          voiceProvider: voiceProvider.value,
          kokoroVoice: kokoroVoice.value,
        },
      },
    });
    team = updated.team;
    editingSettings = false;
    document.body.dataset.teamName = team.name || hubTeams.get(team.id)?.clusterName || 'Assistant Team';
    window.dispatchEvent(new CustomEvent('team-context-changed'));
    saved.dataset.testid = 'team-saved';
    saved.textContent = 'Saved';
    toast('Team settings saved');
    await loadTeams(true);
  });
  saveBtn.className = 'primary compact';
  coreCard.append(saveBtn);
  wrap.append(coreCard);

  // Channels: Joint Bob UI + Telegram Group
  const channelsCard = makeNode('section', 'team-card');
  channelsCard.append(makeNode('h3', '', 'Channels'));
  const uiRow = makeNode('div', 'team-conn-row');
  uiRow.append(makeNode('span', '', 'Joint Bob UI · Desktop & mobile workspace'), makeNode('span', 'team-pill state-done', 'Active'));
  channelsCard.append(uiRow);
  const tgHost = makeNode('div', 'team-telegram-host');
  channelsCard.append(makeNode('h4', '', 'Telegram Group Pairing'), tgHost);
  wrap.append(channelsCard);
  void renderTeamTelegram(tgHost, url, fail, () => refresh(true));

  // System AI & Danger Zone
  const sysCard = makeNode('section', 'team-card');
  sysCard.append(makeNode('h3', '', 'Host & Danger Zone'), makeNode('p', 'team-muted', `Host: ${readiness.host.name} · Decision model: ${readiness.decision.model ?? 'not selected'} (${readiness.decision.ready ? 'ready' : 'unavailable'})`));
  const rowActions = makeNode('div', 'team-row-actions');
  rowActions.append(
    button('System AI settings', 'team-decision-settings', async () => (await import('./settings.js')).openSettings('system-ai')),
    deleteButton(team.id, team.name || hubTeams.get(team.id)?.clusterName || 'this team'),
  );
  sysCard.append(rowActions);
  wrap.append(sysCard);

  settingsWorkspacePanel.append(wrap);
  settingsMirror.replaceChildren(makeNode('h2', '', 'Shared team settings · open the Channels & Settings tab inside your Team Workspace.'));
}

// A 404 alone does not prove a team is gone: a host that is briefly away can answer the same.
async function teamIsGone(teamId, remoteClusterId) {
  const quiet = { quietStatuses: [0, 404] };
  if (!remoteClusterId) return api(`/api/assistant-teams/${encodeURIComponent(teamId)}`, quiet).then(() => false, e => e.status === 404);
  const { teams, unreachable } = await api('/api/team-hub?fresh=1', quiet);
  return !teams.some(item => item.id === teamId) && !unreachable.includes(remoteClusterId);
}

/**
 * When the open team is confirmed gone, says so in place and stops everything that asks for it. The view stays as it is:
 * only the person leaves it. Resolves true when the caller's failure needs no further report.
 */
async function noticeIfGone(teamId, remoteClusterId) {
  const mine = generation;
  if (!await teamIsGone(teamId, remoteClusterId)) return false;
  if (mine !== generation) return true;
  ++generation; stream?.close(); stream = undefined; work?.stop();
  error.textContent = '';
  gone.hidden = false;
  return true;
}

async function refresh(force = false) {
  const mine = generation;
  if (!force && (memoryDirty || editingSettings || document.querySelector('.team-modal-dialog[open]'))) return;
  const refreshRequest = ++refreshGeneration;
  if (!select.value) {
    team = undefined; latestAgents = null; latestRequests = [];
    for (const panel of Object.values(panels)) panel.replaceChildren();
    settingsWorkspacePanel.replaceChildren();
    return;
  }
  const teamId = select.value, url = base(), quiet = { quietStatuses: [404] };
  let loaded;
  try { loaded = await Promise.all([api(url, quiet), api(`${url}/agents`, quiet), api(`${url}/readiness`, quiet)]); }
  catch (e) {
    if (e.status === 404 && (mine !== generation || await noticeIfGone(teamId))) return;
    throw e;
  }
  const [record, agents, readiness] = loaded;
  if (mine !== generation || refreshRequest !== refreshGeneration) return;
  team = record.team;
  latestAgents = agents;
  const displayName = team.name || hubTeams.get(team.id)?.clusterName || 'Assistant Team';
  document.body.dataset.teamName = displayName;
  document.body.dataset.teamSubtitle = `${agents.agents.length} member${agents.agents.length === 1 ? '' : 's'} · Host: ${readiness.host.name}`;
  window.dispatchEvent(new CustomEvent('team-context-changed'));

  if (work) {
    work.setMembers(agents.agents.map(agent => ({ role: agent.role, name: agent.profile?.name ?? null, coordinator: agent.coordinator, ready: !agent.readiness.length })));
    if (!panels.live.contains(work.node)) panels.live.replaceChildren(work.node);
  }
  updateLiveBadges();
  await Promise.all([
    renderMembersWorkspace(url, agents, readiness),
    renderMemoryWorkspace(url, agents),
    renderSettingsWorkspace(url, readiness),
  ]);
  syncWorkspaceTabUi();
}

select.addEventListener('change', () => {
  ++generation; stream?.close(); stream = undefined; team = undefined; latestAgents = null; latestRequests = [];
  editingSettings = false; memoryDirty = false; error.textContent = ''; gone.hidden = true;
  work?.stop(); work = undefined;
  syncMobile();
  const inTeam = Boolean(select.value);
  document.body.classList.toggle('team-context-active', inTeam);
  if (!inTeam) {
    delete document.body.dataset.teamName;
    delete document.body.dataset.teamSubtitle;
  }
  for (const panel of Object.values(panels)) panel.replaceChildren();
  settingsWorkspacePanel.replaceChildren();
  setControlContext(select.value);
  window.dispatchEvent(new CustomEvent('team-context-changed'));
  if (!inTeam) { syncWorkspaceTabUi(); return; }

  activeTeamTab = 'live';
  if (select.value.startsWith('remote:')) {
    const remote = hubTeams.get(select.value.slice(7)), mine = generation;
    document.body.dataset.teamName = remote.name || remote.clusterName;
    document.body.dataset.teamSubtitle = `Hosted on ${remote.hostName}`;
    window.dispatchEvent(new CustomEvent('team-context-changed'));
    const intro = makeNode('section', 'team-card');
    intro.append(makeNode('h2', '', `${remote.name || remote.clusterName}`), makeNode('p', 'team-muted', `Hosted on ${remote.hostName}. Send it work and read its answers here; member connections and memory are managed on ${remote.hostName}.`));
    const ul = makeNode('ul', '');
    for (const member of remote.members) ul.append(makeNode('li', '', `/${member.role}${member.coordinator ? ' (Chief)' : ''}${member.name ? ` — ${member.name}` : ''}${member.ready ? '' : ' · not ready'}`));
    intro.append(ul, deleteButton(remote.id, remote.name || remote.clusterName));
    panels.assistants.append(intro);
    work = createTeamWork(remote.id, remote.members, { isCurrent: () => mine === generation, fail, noticeIfGone: () => noticeIfGone(remote.id, remote.clusterId), isLocal: false, openConversation });
    panels.live.append(work.node);
    switchTeamTab('live');
    return;
  }

  const here = generation, teamId = select.value;
  work = createTeamWork(teamId, hubTeams.get(select.value)?.members ?? [], {
    isCurrent: () => here === generation,
    fail,
    noticeIfGone: () => noticeIfGone(teamId),
    isLocal: true,
    openConversation,
    onRequestsUpdated: reqs => {
      latestRequests = reqs;
      updateLiveBadges();
      if (activeTeamTab === 'assistants' && latestAgents && team) {
        const detail = panels.assistants.querySelector('.team-detail');
        if (detail && !document.querySelector('.team-modal-dialog[open]')) {
          const rows = latestAgents.agents.map(a => ({ role: a.role, assistantId: a.assistantId, profile: a.profile, readiness: a.readiness, coordinator: a.coordinator }));
          drawMemberDetail(detail, base(), rows, { host: { name: hubTeams.get(team.id)?.hostName ?? 'Host' } });
        }
      }
    },
    onProposalDecided: () => void refresh(true),
  });
  panels.live.append(work.node);
  switchTeamTab('live');

  const connection = new EventSource(`${base()}/events`);
  stream = connection;
  connection.onmessage = () => { if (stream === connection) refresh(false).catch(fail); };
  connection.onerror = () => {
    if (stream !== connection) return;
    ++generation; team = undefined; stream = undefined;
    error.textContent = 'Team updates disconnected. Reselect the team to reconnect.';
    connection.close();
    // Deleting a team ends its stream too. A server that does not answer leaves the message above.
    noticeIfGone(teamId).catch(fail);
  };
  refresh(true).catch(fail);
});

window.addEventListener('open-team-workspace', async event => {
  await loadTeams(true);
  if (event.detail?.teamId) selectTeamById(event.detail.teamId, 'live');
});
window.addEventListener('exit-team-context', () => exitTeamContext());
window.addEventListener('pagehide', () => { ++generation; stream?.close(); stream = undefined; });
window.addEventListener('control-center-activated', () => loadTeams().catch(fail));
document.querySelector('#openControlCenterButton')?.addEventListener('click', () => loadTeams().catch(fail));
void loadTeams().catch(() => undefined);
