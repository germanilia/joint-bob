// 4-step Chief-led New Team Setup Wizard.
import { api as request } from './api.js';
import { renderMarkdown } from '../markdown.js';
import { makeButton, makeNode } from './relay-ui.js';
import { createSearchableSelect } from './searchable-select.js';
import { toast } from './shell.js';
import { openExecutionDetailModal, openMemberConnectionsModal } from './control-team-modals.js';
import { renderTeamTelegram } from './control-team-telegram.js';

const api = (path, options = {}) => request(path, { ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });

const STEPS = [
  { id: 1, title: 'Cluster & Chief', sub: 'Name team & pick Chief' },
  { id: 2, title: 'Design with Chief', sub: 'Roles & boundaries' },
  { id: 3, title: 'Connect Services', sub: 'API, MCP, Browser & Voice' },
  { id: 4, title: 'Channels & Launch', sub: 'Joint Bob UI & Telegram' },
];

/** Opens the 4-step Chief-led team setup wizard. */
export function openNewTeamWizard({ clusters = [], teams = [], unreachable = [], onTeamCreated, onLaunch } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'team-modal-dialog team-wizard-dialog';
  dialog.dataset.testid = 'team-wizard-dialog';

  const card = makeNode('div', 'team-modal-card team-wizard-card');
  const head = makeNode('header', 'team-modal-head');
  const titles = makeNode('div', 'team-modal-titles');
  titles.append(makeNode('h2', '', 'New Team Setup with Chief'), makeNode('p', 'team-modal-sub', 'Chief designs the roles, proposes the team blueprint, and walks you through service connections and channels.'));
  const close = makeButton('×', 'team-wizard-close', () => dialog.close());
  close.className = 'ghost icon-button team-modal-close';
  close.setAttribute('aria-label', 'Close');
  head.append(titles, close);

  const stepper = makeNode('nav', 'team-wizard-steps');
  const body = makeNode('div', 'team-modal-body team-wizard-body');
  card.append(head, stepper, body);
  dialog.append(card);
  document.body.append(dialog);
  dialog.showModal();

  let step = 1;
  let teamId = null;
  let teamName = '';
  let chiefName = 'Chief';
  let pollTimer = null;
  let hostAssistants = [];

  const stopPoll = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
  dialog.addEventListener('close', () => { stopPoll(); dialog.remove(); });

  const creatable = clusters.filter(c => !teams.some(t => t.clusterId === c.id) && !unreachable.includes(c.id));

  function drawStepper() {
    stepper.replaceChildren(...STEPS.map(item => {
      const btn = makeNode('button', `team-wizard-step${step === item.id ? ' active' : ''}${item.id < step ? ' done' : ''}`);
      btn.type = 'button';
      btn.disabled = !teamId && item.id > 1;
      btn.append(makeNode('span', 'team-wizard-num', String(item.id)), makeNode('span', 'team-wizard-step-copy', ''));
      btn.lastChild.append(makeNode('strong', '', item.title), makeNode('small', '', item.sub));
      btn.addEventListener('click', () => { if (teamId || item.id === 1) { step = item.id; drawStep(); } });
      return btn;
    }));
  }

  function drawStep() {
    stopPoll();
    drawStepper();
    if (step === 1) renderStep1();
    else if (step === 2) renderStep2();
    else if (step === 3) renderStep3();
    else renderStep4();
  }

  async function loadLocalAssistants() {
    try {
      const res = await api('/api/control-center/assistants');
      hostAssistants = (res.assistants ?? []).filter(a => a.local);
    } catch { hostAssistants = []; }
  }

  function buildClusterOptions() {
    const teamByCluster = new Map(teams.map(t => [t.clusterId, t]));
    const available = [];
    const existing = [];
    const unavailable = [];
    for (const cluster of clusters) {
      const existingTeam = teamByCluster.get(cluster.id);
      if (existingTeam) {
        const label = existingTeam.name || existingTeam.clusterName || cluster.name;
        existing.push({
          value: cluster.id,
          label: cluster.name,
          detail: existingTeam.local ? `Already has team "${label}" on this node` : `Already has team "${label}" on ${existingTeam.hostName}`,
          keywords: label,
          group: 'Already has a team',
          disabled: true,
        });
      } else if (unreachable.includes(cluster.id)) {
        unavailable.push({
          value: cluster.id,
          label: cluster.name,
          detail: 'Cluster peer unreachable — retry when online',
          group: 'Unavailable',
          disabled: true,
        });
      } else {
        available.push({
          value: cluster.id,
          label: cluster.name,
          detail: 'Hosted on this node',
          group: 'Available clusters',
        });
      }
    }
    return [...available, ...existing, ...unavailable];
  }

  function renderStep1() {
    body.replaceChildren();
    const wrap = makeNode('div', 'team-wizard-pane');
    wrap.append(makeNode('h3', '', '1. Pick Cluster, Team Name & Chief'), makeNode('p', 'team-muted', 'Choose which cluster hosts this team, give it a custom name, and choose who acts as your Chief (/chief).'));

    const clusterOptions = buildClusterOptions();
    const clusterField = makeNode('div', 'team-field team-wizard-cluster-field');
    const clusterLabel = makeNode('label', 'team-section-eyebrow', 'CLUSTER');
    clusterLabel.htmlFor = 'teamWizardCluster';
    const clusterSelect = createSearchableSelect({
      id: 'teamWizardCluster',
      testid: 'team-wizard-cluster',
      label: 'Cluster',
      prompt: 'Choose a cluster…',
      placeholder: 'Search clusters…',
      emptyText: 'No matching clusters',
    });
    clusterSelect.setOptions(clusterOptions);
    clusterField.append(clusterLabel, clusterSelect.root);

    if (!creatable.length) {
      if (clusterOptions.length) wrap.append(clusterField);
      wrap.append(makeNode('p', 'team-muted', clusters.length
        ? 'Every cluster you joined already has a team on this host (or has an unreachable peer). Continue configuring an existing team below, or create a new cluster in Settings → Clusters.'
        : 'No cluster found yet. Create a cluster in Settings → Clusters first.'));
      const existingList = makeNode('div', 'team-wizard-clusters');
      for (const existing of teams.filter(t => t.local)) {
        const pick = makeButton(`Continue setup: ${existing.name || existing.clusterName}`, `team-wizard-continue-${existing.id}`, () => {
          teamId = existing.id; teamName = existing.name || existing.clusterName; step = 2; drawStep();
        });
        pick.className = 'ghost compact';
        existingList.append(pick);
      }
      wrap.append(existingList);
      body.append(wrap);
      return;
    }

    let chosenCluster = creatable[0];
    clusterSelect.setValue(chosenCluster.id);
    const nameField = document.createElement('input');
    nameField.type = 'text';
    nameField.value = chosenCluster.name;
    nameField.placeholder = 'e.g. Home, DevOps On-Call';
    nameField.dataset.testid = 'team-wizard-name';

    clusterSelect.onChange(clusterId => {
      const next = creatable.find(c => c.id === clusterId);
      if (!next) return;
      if (nameField.value === chosenCluster.name || !nameField.value.trim()) nameField.value = next.name;
      chosenCluster = next;
    });

    const localExisting = teams.filter(t => t.local);
    if (localExisting.length) {
      const note = makeNode('div', 'team-wizard-existing-note');
      note.append(makeNode('span', 'team-muted', 'Already has a team (one team per cluster on this host): '));
      for (const existing of localExisting) {
        const jump = makeButton(`Continue ${existing.name || existing.clusterName} →`, `team-wizard-continue-${existing.id}`, () => {
          teamId = existing.id; teamName = existing.name || existing.clusterName; step = 2; drawStep();
        });
        jump.className = 'ghost compact';
        note.append(jump);
      }
      clusterField.append(note);
    }

    const grid = makeNode('div', 'team-wizard-grid');
    const teamNameLabel = makeNode('label', 'team-field');
    teamNameLabel.append(makeNode('span', '', 'Team Name'), nameField);

    const chiefModeWrap = makeNode('label', 'team-field');
    const chiefModeHead = makeNode('span', 'team-inline-label');
    chiefModeHead.append(document.createTextNode('Chief Name '), makeNode('code', 'team-inline-code', '(/chief)'));
    const chiefInput = document.createElement('input');
    chiefInput.type = 'text';
    chiefInput.value = 'Chief';
    chiefInput.placeholder = 'e.g. Mordecai, Atlas';
    chiefInput.dataset.testid = 'team-wizard-chief-name';
    chiefModeWrap.append(chiefModeHead, chiefInput);

    const harnessWrap = makeNode('label', 'team-field');
    harnessWrap.append(makeNode('span', '', 'Chief Harness'));
    const harnessSelect = document.createElement('select');
    harnessSelect.dataset.testid = 'team-wizard-harness';
    for (const [val, label] of [['antigravity', 'Google Antigravity'], ['pi', 'Pi'], ['claude', 'Claude Code'], ['codex', 'Codex'], ['kiro', 'Kiro']]) {
      harnessSelect.append(new Option(label, val));
    }
    harnessWrap.append(harnessSelect);

    const existingWrap = makeNode('label', 'team-field');
    existingWrap.append(makeNode('span', '', 'Or pick existing assistant on this host'));
    const existingSelect = document.createElement('select');
    existingSelect.dataset.testid = 'team-wizard-existing-chief';
    existingSelect.append(new Option('Create a new Chief assistant', ''));
    existingWrap.append(existingSelect);
    void loadLocalAssistants().then(() => {
      for (const a of hostAssistants) existingSelect.append(new Option(a.name, a.id));
    });
    existingSelect.addEventListener('change', () => {
      const useExisting = Boolean(existingSelect.value);
      chiefInput.disabled = useExisting;
      harnessSelect.disabled = useExisting;
    });

    const allowBobLabel = makeNode('label', 'team-check-row team-wizard-bob-toggle');
    const allowBobBox = document.createElement('input');
    allowBobBox.type = 'checkbox';
    allowBobBox.checked = true;
    allowBobBox.dataset.testid = 'team-wizard-allow-bob';
    allowBobLabel.append(allowBobBox, makeNode('span', '', 'Allow Personal Bob on this node to ask this team\'s Chief'));

    grid.append(teamNameLabel, chiefModeWrap, harnessWrap, existingWrap);
    const footer = makeNode('div', 'team-wizard-actions');
    const createBtn = makeButton('Start Designing with Chief →', 'team-wizard-create', async () => {
      const cleanName = nameField.value.trim() || chosenCluster.name;
      createBtn.disabled = true;
      try {
        const created = await api('/api/assistant-teams', { method: 'POST', body: { clusterId: chosenCluster.id, name: cleanName, allowBob: allowBobBox.checked } });
        teamId = created.team.id;
        teamName = cleanName;
        if (existingSelect.value) {
          await api(`/api/assistant-teams/${encodeURIComponent(teamId)}/chief`, { method: 'POST', body: { mode: 'existing', assistantId: existingSelect.value, role: 'chief' } });
          chiefName = existingSelect.selectedOptions[0]?.textContent || 'Chief';
        } else {
          chiefName = chiefInput.value.trim() || 'Chief';
          await api(`/api/assistant-teams/${encodeURIComponent(teamId)}/chief`, { method: 'POST', body: { mode: 'create', name: chiefName, role: 'chief', harnessId: harnessSelect.value } });
        }
        onTeamCreated?.(teamId);
        step = 2;
        drawStep();
      } catch (err) {
        toast.error(err.message);
        createBtn.disabled = false;
      }
    });
    createBtn.className = 'primary';
    footer.append(createBtn);

    wrap.append(clusterField, grid, allowBobLabel, footer);
    body.append(wrap);
  }

  const formatElapsed = (iso) => {
    const ms = iso ? Date.now() - Date.parse(iso) : NaN;
    if (!Number.isFinite(ms) || ms < 0) return '';
    const sec = Math.floor(ms / 1000);
    return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  };

  function renderStep2() {
    body.replaceChildren();
    const wrap = makeNode('div', 'team-wizard-pane');
    wrap.append(makeNode('h3', '', `2. Design "${teamName}" with ${chiefName} (/chief)`), makeNode('p', 'team-muted', 'Describe the specialist roles, boundaries, and services you want. Chief inspects this host with team_node_catalog and submits a blueprint proposal for your approval right here.'));

    const rosterBar = makeNode('div', 'team-wizard-roster');
    const feed = makeNode('div', 'team-wizard-feed');
    const form = makeNode('form', 'team-wizard-composer');
    const input = document.createElement('textarea');
    input.rows = 2;
    input.placeholder = 'Ask Chief to adjust a role, boundary, or skill — or describe what this team should cover…';
    input.dataset.testid = 'team-wizard-prompt';
    const sendRow = makeNode('div', 'team-wizard-composer-bar');
    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'primary compact';
    sendBtn.textContent = `Send to ${chiefName}`;
    sendRow.append(makeNode('span', 'team-muted team-wizard-composer-hint', 'Cmd/Ctrl+Enter to send'), sendBtn);
    form.append(input, sendRow);
    input.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); } });

    let lastRenderKey = '';

    const renderUserBrief = (text) => {
      const box = makeNode('div', 'team-wizard-msg-user');
      const clean = String(text ?? '').trim();
      if (clean.length <= 260) {
        box.textContent = clean;
        return box;
      }
      const details = document.createElement('details');
      details.className = 'team-wizard-brief-details';
      const summary = document.createElement('summary');
      summary.textContent = `${clean.slice(0, 180).replace(/\s+/g, ' ')}…`;
      const full = makeNode('div', 'team-wizard-brief-full', clean);
      details.append(summary, full);
      box.append(details);
      return box;
    };

    const refreshDesign = async (force = false, scrollToBottom = false) => {
      if (!teamId || !dialog.open) return;
      try {
        const [{ agents }, { requests }, { proposals }] = await Promise.all([
          api(`/api/assistant-teams/${encodeURIComponent(teamId)}/agents`),
          api(`/api/team-hub/${encodeURIComponent(teamId)}/requests`),
          api(`/api/team-hub/${encodeURIComponent(teamId)}/proposals`),
        ]);
        const recent = (requests ?? []).slice(0, 6).reverse();
        const activeTraces = new Map();
        const activeAssignments = recent
          .filter(r => ['queued', 'running', 'waiting_for_human'].includes(r.state))
          .map(r => r.assignments.find(a => ['running', 'queued', 'waiting_for_human', 'accepted'].includes(a.state)) ?? r.assignments[0])
          .filter(Boolean);
        await Promise.all(activeAssignments.map(async a => {
          try {
            const { trace } = await api(`/api/assistant-teams/${encodeURIComponent(teamId)}/assignments/${encodeURIComponent(a.id)}/trace`);
            if (trace) activeTraces.set(a.id, trace);
          } catch { /* trace may not exist yet */ }
        }));

        const pending = (proposals ?? []).filter(p => p.state === 'pending');
        const hasActive = activeAssignments.length > 0;
        const renderKey = JSON.stringify({
          agents: agents.map(a => [a.role, a.profile?.name, a.coordinator]),
          pending: pending.map(p => [p.id, p.state, p.summary, p.previews?.length]),
          recent: recent.map(r => [r.id, r.state, r.assignments.map(a => [a.id, a.state, a.result?.length ?? 0, a.reason])]),
          traces: [...activeTraces.entries()].map(([id, t]) => [id, t.toolCallCount, t.reason]),
          tick: hasActive ? Math.floor(Date.now() / 5000) : 0,
        });
        if (!force && renderKey === lastRenderKey) return;
        const wasFirst = lastRenderKey === '';
        const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
        lastRenderKey = renderKey;
        const prevScroll = body.scrollTop;

        rosterBar.replaceChildren(
          makeNode('span', 'team-muted', 'Current members: '),
          ...agents.map(a => makeNode('span', 'team-pill', `/${a.role}${a.profile ? ` · ${a.profile.name}` : ''}${a.coordinator ? ' (Chief)' : ''}`)),
        );

        feed.replaceChildren();
        for (const req of recent) {
          const item = makeNode('article', 'team-wizard-msg');
          item.append(renderUserBrief(req.text));
          const pub = req.assignments.find(a => !a.delegated && a.result);
          const primary = pub ?? req.assignments.find(a => ['running', 'queued', 'waiting_for_human', 'accepted'].includes(a.state)) ?? req.assignments[0];
          if (pub?.result) {
            const reply = makeNode('div', 'team-wizard-msg-chief');
            const replyBody = makeNode('div', 'team-wizard-msg-chief-body markdown');
            renderMarkdown(replyBody, pub.result);
            reply.append(replyBody);
            if (primary?.id) {
              const foot = makeNode('div', 'team-wizard-msg-foot');
              const inspect = makeButton('Inspect execution →', `wizard-trace-${primary.id}`, () => void openExecutionDetailModal(teamId, primary.id));
              inspect.className = 'ghost compact team-wizard-secondary-btn';
              foot.append(inspect);
              reply.append(foot);
            }
            item.append(reply);
          } else {
            const isActive = ['queued', 'running', 'waiting_for_human'].includes(req.state);
            const liveCard = makeNode('div', `team-wizard-live-card${isActive ? ' is-active' : ''}`);
            const headRow = makeNode('div', 'team-wizard-live-head');
            if (isActive) headRow.append(makeNode('span', 'team-wizard-pulse', ''));
            const stateTitle = req.state === 'running'
              ? `${chiefName} is working…`
              : req.state === 'queued'
                ? `Queued for ${chiefName}…`
                : req.state === 'waiting_for_human'
                  ? `${chiefName} is waiting for your input`
                  : `${chiefName} ${req.state.replaceAll('_', ' ')}`;
            headRow.append(makeNode('strong', '', stateTitle));
            const elapsed = formatElapsed(req.createdAt);
            if (isActive && elapsed) headRow.append(makeNode('span', 'team-pill', elapsed));
            if (primary?.id) {
              const inspect = makeButton('Inspect live →', `wizard-trace-${primary.id}`, () => void openExecutionDetailModal(teamId, primary.id));
              inspect.className = 'ghost compact team-wizard-live-btn team-wizard-secondary-btn';
              headRow.append(inspect);
            }
            liveCard.append(headRow);

            const trace = primary?.id ? activeTraces.get(primary.id) : null;
            const reason = trace?.reason || primary?.reason;
            if (reason) liveCard.append(makeNode('p', 'team-muted team-wizard-live-note', reason));

            const calls = trace?.toolCalls ?? [];
            if (calls.length) {
              const steps = makeNode('div', 'team-wizard-live-steps');
              for (const call of calls.slice(-4)) {
                const dur = Number.isFinite(call.durationMs) ? ` (${(call.durationMs / 1000).toFixed(1)}s)` : '';
                const line = makeNode('div', `team-wizard-live-step${call.ok === false ? ' is-error' : ''}`);
                line.append(
                  makeNode('span', 'team-wizard-step-mark', call.ok === false ? '✕' : '✓'),
                  makeNode('code', 'team-inline-code', call.name),
                  makeNode('span', 'team-muted', `${call.target ? ` ${call.target}` : ''}${dur}`),
                );
                steps.append(line);
              }
              liveCard.append(steps);
            } else if (isActive) {
              liveCard.append(makeNode('p', 'team-muted team-wizard-live-note', req.state === 'queued'
                ? 'Starting Chief session and checking host readiness…'
                : 'Inspecting host catalog and drafting your team blueprint…'));
            }
            item.append(liveCard);
          }
          feed.append(item);
        }
        for (const proposal of pending) {
          const cardEl = makeNode('article', 'team-proposal-card team-wizard-proposal');
          const headEl = makeNode('div', 'team-wizard-proposal-head');
          headEl.append(makeNode('span', 'team-pill state-done', 'Proposed Blueprint'), makeNode('strong', 'team-wizard-proposal-title', proposal.summary));
          cardEl.append(headEl);
          if (proposal.rationale) cardEl.append(makeNode('p', 'team-wizard-proposal-rationale', proposal.rationale));
          const list = makeNode('ul', 'team-proposal-changes');
          for (const preview of proposal.previews ?? []) list.append(makeNode('li', 'team-proposal-change-row', preview.headline));
          const actions = makeNode('div', 'team-row-actions');
          const approve = makeButton('Approve & Create Roles →', `wizard-approve-${proposal.id}`, async () => {
            approve.disabled = true;
            await api(`/api/team-hub/${encodeURIComponent(teamId)}/proposals/${encodeURIComponent(proposal.id)}/decide`, { method: 'POST', body: { decision: 'approve' } });
            toast('Blueprint approved and applied live');
            await refreshDesign(true, true);
          });
          approve.className = 'primary compact';
          const reject = makeButton('Ask to adjust (Reject)', `wizard-reject-${proposal.id}`, async () => {
            reject.disabled = true;
            await api(`/api/team-hub/${encodeURIComponent(teamId)}/proposals/${encodeURIComponent(proposal.id)}/decide`, { method: 'POST', body: { decision: 'reject' } });
            await refreshDesign(true, true);
          });
          reject.className = 'ghost compact team-wizard-secondary-btn';
          actions.append(approve, reject);
          cardEl.append(list, actions);
          feed.append(cardEl);
        }
        if (!pending.length && !recent.length) {
          feed.append(makeNode('p', 'team-muted', `Send your first design brief to ${chiefName} below, or skip ahead to connect services.`));
        }
        body.scrollTop = (scrollToBottom || wasFirst || nearBottom) ? body.scrollHeight : prevScroll;
      } catch { /* retry next poll */ }
    };

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const message = input.value.trim();
      if (!message) return;
      sendBtn.disabled = true;
      try {
        await api(`/api/team-hub/${encodeURIComponent(teamId)}/assign`, { method: 'POST', body: { role: null, message } });
        input.value = '';
        await refreshDesign(true, true);
      } catch (err) { toast.error(err.message); }
      finally { sendBtn.disabled = false; }
    });

    const footer = makeNode('div', 'team-wizard-actions');
    const nextBtn = makeButton('Next: Connect Services & Voice →', 'team-wizard-to-3', () => { step = 3; drawStep(); });
    nextBtn.className = 'primary';
    footer.append(nextBtn);

    wrap.append(rosterBar, feed, form, footer);
    body.append(wrap);
    void refreshDesign();
    pollTimer = setInterval(refreshDesign, 2500);
  }

  async function renderStep3() {
    body.replaceChildren(makeNode('p', 'team-muted', 'Loading team members & voice options…'));
    let teamRec, agentsRes, catalogRes;
    try {
      [teamRec, agentsRes, catalogRes] = await Promise.all([
        api(`/api/assistant-teams/${encodeURIComponent(teamId)}`),
        api(`/api/assistant-teams/${encodeURIComponent(teamId)}/agents`),
        api(`/api/assistant-teams/${encodeURIComponent(teamId)}/catalog?light=1`),
      ]);
    } catch (err) { body.replaceChildren(makeNode('p', 'team-error-inline', err.message)); return; }

    const wrap = makeNode('div', 'team-wizard-pane');
    wrap.append(makeNode('h3', '', '3. Connect Services & Voice Briefs'), makeNode('p', 'team-muted', `Click Connect on any role to configure API secrets, MCP servers, skills, or Live Browser Login on ${catalogRes.host.name}.`));

    const list = makeNode('div', 'team-conn-list');
    for (const agent of agentsRes.agents) {
      const row = makeNode('div', 'team-conn-row');
      const info = makeNode('div', '');
      info.append(
        makeNode('strong', '', `${agent.profile?.name ?? agent.role} (/${agent.role})${agent.coordinator ? ' · Chief' : ''}`),
        makeNode('small', 'team-muted', ` · ${(agent.profile?.uses ?? []).join(' · ') || 'No services attached yet'}`),
      );
      const btn = makeButton('Connect / Configure', `wizard-connect-${agent.role}`, () => {
        void openMemberConnectionsModal(teamId, agent.role, { onSaved: () => { void renderStep3(); } });
      });
      btn.className = 'primary compact';
      row.append(info, btn);
      list.append(row);
    }
    wrap.append(list);

    // Voice Briefs choice: Kokoro (Joint Bob Local Voice) vs ElevenLabs
    const voiceCard = makeNode('section', 'team-card team-voice-card');
    voiceCard.append(makeNode('h4', '', 'Voice Briefs Engine (Optional)'), makeNode('p', 'team-muted', 'Choose Joint Bob\'s built-in local voice (Kokoro) for free offline briefs, or ElevenLabs for custom cloud voices.'));
    const currentVoice = teamRec.team.settings.voiceProvider || 'kokoro';
    const providerSelect = document.createElement('select');
    providerSelect.append(
      new Option(`Joint Bob Local Voice (Kokoro) ${catalogRes.voice.local.installed ? '· Ready' : '· Available to install'}`, 'kokoro'),
      new Option('ElevenLabs (requires ELEVENLABS_API_KEY secret)', 'elevenlabs'),
    );
    providerSelect.value = currentVoice;

    const kokoroSelect = document.createElement('select');
    for (const v of catalogRes.voice.kokoroVoices) kokoroSelect.append(new Option(v.label, v.id));
    kokoroSelect.value = teamRec.team.settings.kokoroVoice || 'af_heart';
    const syncVoiceUi = () => { kokoroSelect.hidden = providerSelect.value !== 'kokoro'; };
    providerSelect.addEventListener('change', syncVoiceUi);
    syncVoiceUi();

    const saveVoice = makeButton('Save voice choice', 'wizard-save-voice', async () => {
      const latest = (await api(`/api/assistant-teams/${encodeURIComponent(teamId)}`)).team;
      await api(`/api/assistant-teams/${encodeURIComponent(teamId)}/settings`, {
        method: 'PUT',
        body: {
          expectedRevision: latest.revision,
          settings: { ...latest.settings, voiceProvider: providerSelect.value, kokoroVoice: kokoroSelect.value },
        },
      });
      toast(`Voice briefs set to ${providerSelect.value === 'kokoro' ? 'Joint Bob Local Voice (Kokoro)' : 'ElevenLabs'}`);
    });
    saveVoice.className = 'ghost compact';
    const voiceBar = makeNode('div', 'team-inline-bar');
    voiceBar.append(providerSelect, kokoroSelect, saveVoice);
    voiceCard.append(voiceBar);
    wrap.append(voiceCard);

    const footer = makeNode('div', 'team-wizard-actions');
    const backBtn = makeButton('← Back to Design', 'team-wizard-back-2', () => { step = 2; drawStep(); });
    backBtn.className = 'ghost';
    const nextBtn = makeButton('Next: Channels & Launch →', 'team-wizard-to-4', () => { step = 4; drawStep(); });
    nextBtn.className = 'primary';
    footer.append(backBtn, nextBtn);
    wrap.append(footer);
    body.replaceChildren(wrap);
  }

  async function renderStep4() {
    body.replaceChildren();
    const wrap = makeNode('div', 'team-wizard-pane');
    wrap.append(makeNode('h3', '', '4. Channels & Launch'), makeNode('p', 'team-muted', 'Joint Bob UI is active immediately. Optionally connect a Telegram group so you can talk to Chief from Telegram too.'));

    const uiCard = makeNode('div', 'team-conn-row');
    uiCard.append(makeNode('div', '', 'Joint Bob UI · Active immediately (desktop & mobile)'), makeNode('span', 'team-pill state-done', 'Active'));
    wrap.append(uiCard);

    const tgCard = makeNode('section', 'team-card');
    tgCard.append(makeNode('h4', '', 'Telegram Group Pairing'));
    const tgHost = makeNode('div', '');
    tgCard.append(tgHost);
    wrap.append(tgCard);
    void renderTeamTelegram(tgHost, `/api/assistant-teams/${encodeURIComponent(teamId)}`, err => toast.error(err.message), () => { void renderStep4(); });

    const footer = makeNode('div', 'team-wizard-actions');
    const backBtn = makeButton('← Back to Services', 'team-wizard-back-3', () => { step = 3; drawStep(); });
    backBtn.className = 'ghost';
    const launchBtn = makeButton(`Launch "${teamName}" Workspace →`, 'team-wizard-launch', () => {
      const launchedId = teamId;
      dialog.close();
      onLaunch?.(launchedId);
    });
    launchBtn.className = 'primary';
    footer.append(backBtn, launchBtn);
    wrap.append(footer);
    body.append(wrap);
  }

  drawStep();
}
