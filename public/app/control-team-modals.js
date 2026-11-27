// In-context modals for Assistant Teams: Execution Detail drill-down & Member Service Connections.
import { api as request } from './api.js';
import { createBrowserViewer } from './browser-viewer.js';
import { renderMarkdown } from '../markdown.js';
import { makeButton, makeNode } from './relay-ui.js';
import { confirmAction, toast } from './shell.js';

const api = (path, options = {}) => request(path, { ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });

function createDialog(className, titleText, subtitleText) {
  const dialog = document.createElement('dialog');
  dialog.className = `team-modal-dialog ${className}`;
  const card = makeNode('div', 'team-modal-card');
  const head = makeNode('header', 'team-modal-head');
  const titles = makeNode('div', 'team-modal-titles');
  titles.append(makeNode('h2', '', titleText));
  if (subtitleText) titles.append(makeNode('p', 'team-modal-sub', subtitleText));
  const close = makeButton('×', 'team-modal-close', () => dialog.close());
  close.className = 'ghost icon-button team-modal-close';
  close.setAttribute('aria-label', 'Close');
  head.append(titles, close);
  const body = makeNode('div', 'team-modal-body');
  card.append(head, body);
  dialog.append(card);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, head };
}

function openLiveBrowserUrl(session) {
  if (!session?.id || !session?.nodeId) return;
  const params = new URLSearchParams({ mode: 'browser', browserSessionId: session.id, nodeId: session.nodeId });
  window.open(`/?${params.toString()}`, '_blank', 'noopener');
}

function openInlineBrowserLogin(session, { role, label, hostName, onDone }) {
  if (!session?.id || !session?.nodeId) return;
  const { dialog, body } = createDialog(
    'team-browser-login-dialog',
    `Sign in · ${label || 'Live Browser'} (/${role})`,
    `Sign in interactively below. This persistent browser profile stays saved on ${hostName} and pinned to /${role}.`,
  );
  dialog.dataset.testid = 'team-inline-browser-modal';
  const bar = makeNode('div', 'team-browser-login-bar');
  const note = makeNode('span', 'team-muted', 'Scan QR code or complete login/SSO in the live view below, then click Done.');
  const actions = makeNode('div', 'team-row-actions');
  const popout = makeButton('Open in new tab ↗', 'team-browser-popout', () => openLiveBrowserUrl(session));
  popout.className = 'ghost compact team-wizard-secondary-btn';
  const doneBtn = makeButton(`I'm signed in — Save for /${role}`, 'team-browser-done', () => dialog.close());
  doneBtn.className = 'primary compact';
  actions.append(popout, doneBtn);
  bar.append(note, actions);

  const host = makeNode('div', 'team-browser-viewer-host');
  body.append(bar, host);

  let viewer = null;
  const identity = session.projectId && session.conversationId
    ? { projectId: session.projectId, engine: session.engine || 'pi', conversationId: session.conversationId, appNodeId: session.appNodeId || session.nodeId }
    : undefined;
  try {
    viewer = createBrowserViewer(host, {
      api: request,
      identity,
      sessionId: session.id,
      nodeId: session.nodeId,
      confirm: confirmAction,
      onClose: () => dialog.close(),
    });
  } catch {
    host.replaceChildren(makeNode('p', 'team-muted', 'Could not mount inline viewer — click "Open in new tab" above to complete sign-in.'));
  }

  dialog.addEventListener('close', () => {
    viewer?.dispose?.();
    void onDone?.();
  }, { once: true });
}

/** Opens the in-context Execution Detail modal for one team assignment. */
export async function openExecutionDetailModal(teamId, assignmentId, { openConversation } = {}) {
  const { dialog, body } = createDialog('team-trace-dialog', 'Execution detail', 'Loading execution trace…');
  dialog.dataset.testid = 'team-execution-modal';
  const sub = dialog.querySelector('.team-modal-sub');
  try {
    const { trace } = await api(`/api/assistant-teams/${encodeURIComponent(teamId)}/assignments/${encodeURIComponent(assignmentId)}/trace`);
    const model = trace.attribution ? `${trace.attribution.harnessId} · ${trace.attribution.provider}/${trace.attribution.modelId} (${trace.attribution.reasoning})` : (trace.engine || 'default runtime');
    sub.textContent = `/${trace.role} · ${trace.state} · ${model} · ${trace.toolCallCount} tool call${trace.toolCallCount === 1 ? '' : 's'}${trace.toolErrorCount ? ` (${trace.toolErrorCount} error${trace.toolErrorCount === 1 ? '' : 's'})` : ''}`;
    body.replaceChildren();

    const meta = makeNode('div', 'team-trace-meta');
    meta.append(
      makeNode('span', `team-pill state-${trace.state}`, trace.state),
      makeNode('span', 'team-pill', trace.delegated ? 'Delegated by coordinator' : 'Direct / root turn'),
      makeNode('span', 'team-pill', `/${trace.role}`),
    );
    if (trace.conversationId && openConversation) {
      const openBtn = makeButton('Open full conversation →', 'team-trace-open-conv', () => {
        dialog.close();
        openConversation({ projectId: trace.projectId, conversationId: trace.conversationId, engine: trace.engine || 'pi' });
      });
      openBtn.className = 'ghost compact';
      meta.append(openBtn);
    }
    body.append(meta);

    if (trace.prompt) {
      const promptBox = makeNode('section', 'team-trace-section');
      promptBox.append(makeNode('h3', '', 'Prompt'), makeNode('pre', 'team-trace-pre', trace.prompt));
      body.append(promptBox);
    }

    const toolsBox = makeNode('section', 'team-trace-section');
    toolsBox.append(makeNode('h3', '', `Tool calls (${trace.toolCalls.length})`));
    if (!trace.toolCalls.length) {
      toolsBox.append(makeNode('p', 'team-muted', 'No tool calls recorded in the latest turn.'));
    } else {
      const list = makeNode('div', 'team-trace-steps');
      for (const [idx, call] of trace.toolCalls.entries()) {
        const step = makeNode('article', `team-trace-step${call.isError ? ' is-error' : ''}`);
        const top = makeNode('div', 'team-trace-step-head');
        top.append(
          makeNode('span', 'team-trace-idx', `#${idx + 1}`),
          makeNode('code', 'team-trace-tool', call.toolName),
          ...(call.target ? [makeNode('span', 'team-trace-target', call.target)] : []),
          ...(call.durationMs !== undefined ? [makeNode('span', 'team-trace-dur', `${call.durationMs}ms`)] : []),
          ...(call.isError ? [makeNode('span', 'team-pill state-stopped', 'error')] : []),
        );
        step.append(top);
        if (call.excerpt) {
          const det = makeNode('details');
          det.open = Boolean(call.isError);
          det.append(makeNode('summary', '', call.isError ? 'Error output' : 'Output excerpt'), makeNode('pre', 'team-trace-pre', call.excerpt));
          step.append(det);
        }
        list.append(step);
      }
      toolsBox.append(list);
    }
    body.append(toolsBox);

    if (trace.result || trace.reason) {
      const resBox = makeNode('section', 'team-trace-section');
      resBox.append(makeNode('h3', '', 'Result'));
      if (trace.reason) resBox.append(makeNode('p', 'team-muted', `Status detail: ${trace.reason}`));
      if (trace.result) {
        const out = makeNode('div', 'team-trace-markdown markdown');
        renderMarkdown(out, trace.result);
        resBox.append(out);
      }
      body.append(resBox);
    }
  } catch (err) {
    sub.textContent = 'Could not load trace';
    body.replaceChildren(makeNode('p', 'team-error-inline', err.message));
  }
}

/** Opens the in-context Service Connections modal for a team member (never leaves team context). */
export async function openMemberConnectionsModal(teamId, role, { onSaved } = {}) {
  const { dialog, body } = createDialog('team-conn-dialog', `Connect services for /${role}`, 'Choose how to connect each service (Skill + API, MCP Server, or Live Browser Login).');
  dialog.dataset.testid = 'team-connections-modal';
  const base = `/api/assistant-teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(role)}`;
  let activeMethod = null;

  const render = async () => {
    body.replaceChildren(makeNode('p', 'team-muted', 'Loading connections…'));
    let data;
    try { data = await api(`${base}/connections`); }
    catch (err) { body.replaceChildren(makeNode('p', 'team-error-inline', err.message)); return; }

    if (!activeMethod) {
      activeMethod = !data.profile.allowTerminal && data.profile.allowBrowser ? 'browser' : 'skill-api';
    }

    dialog.querySelector('h2').textContent = `Connect services · ${data.profile.name} (/${role})`;
    dialog.querySelector('.team-modal-sub').textContent = `Host: ${data.host.name} · Pick how /${role} should connect to each service. Changes apply live.`;

    const prompt = makeNode('div', 'team-conn-picker-head');
    prompt.append(makeNode('strong', '', `How do you want to connect a service for /${role}?`));
    const picker = makeNode('div', 'team-conn-methods');
    const content = makeNode('div', 'team-conn-content');
    const skillCount = data.skills.filter(s => s.enabled).length;
    const mcpCount = data.mcpServers.filter(m => m.enabled).length;
    const methodDefs = [
      ['skill-api', 'Skill + API Secret', `Fastest & headless (Gmail, Calendar, ElevenLabs) · ${data.attachedSecrets.length} secret${data.attachedSecrets.length === 1 ? '' : 's'} · ${skillCount} skill${skillCount === 1 ? '' : 's'}`],
      ['mcp', 'MCP Server', `Use installed MCP tools (Jira, AWS, Figma) · ${mcpCount} enabled`],
      ['browser', 'Web / Live Browser Login', `Sign in interactively here (WhatsApp QR, Sela SSO) · ${data.logins.length} saved session${data.logins.length === 1 ? '' : 's'}`],
    ];

    const reload = async () => { await render(); onSaved?.(); };
    const drawMethod = () => {
      for (const btn of picker.querySelectorAll('button')) btn.classList.toggle('selected', btn.dataset.method === activeMethod);
      content.replaceChildren();
      if (activeMethod === 'skill-api') {
        renderSecretsTab(content, base, data, reload);
        renderSkillsTab(content, base, data, reload);
      } else if (activeMethod === 'mcp') {
        renderMcpTab(content, base, data, reload);
      } else {
        renderBrowserTab(content, base, data, role, reload);
      }
    };

    for (const [id, title, sub] of methodDefs) {
      const btn = makeNode('button', 'team-conn-method-card');
      btn.type = 'button';
      btn.dataset.method = id;
      btn.dataset.testid = `team-conn-tab-${id}`;
      btn.append(makeNode('strong', '', title), makeNode('small', 'team-muted', sub));
      btn.addEventListener('click', () => { activeMethod = id; drawMethod(); });
      picker.append(btn);
    }
    body.replaceChildren(prompt, picker, content);
    drawMethod();
  };

  await render();
}

function renderSecretsTab(parent, base, data, reload) {
  const attachedIds = new Set(data.attachedSecrets.map(s => s.id));
  const selected = new Set(attachedIds);
  const section = makeNode('div', 'team-conn-section');
  section.append(makeNode('h3', '', `Attachable secrets on ${data.host.name}`));
  if (!data.availableSecrets.length) {
    section.append(makeNode('p', 'team-muted', 'No shared secrets available yet for this team. Add one securely below.'));
  } else {
    const list = makeNode('div', 'team-check-list');
    for (const secret of data.availableSecrets) {
      const row = makeNode('label', 'team-check-row');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selected.has(secret.id);
      box.disabled = !data.editable;
      box.addEventListener('change', () => { if (box.checked) selected.add(secret.id); else selected.delete(secret.id); });
      const copy = makeNode('span', 'team-check-copy');
      const varNames = (secret.variables ?? []).map(v => v.name).join(', ');
      copy.append(makeNode('strong', '', secret.label), makeNode('small', 'team-muted', `${secret.provider} · ${varNames || 'no vars'}`));
      row.append(box, copy);
      list.append(row);
    }
    section.append(list);
    if (data.editable) {
      const saveBtn = makeButton('Save secret selection', 'team-conn-save-secrets', async () => {
        await api(`${base}/connections`, { method: 'PUT', body: { secretAccountIds: [...selected] } });
        toast('Secrets updated');
        await reload();
      });
      saveBtn.className = 'primary compact';
      section.append(saveBtn);
    }
  }
  parent.append(section);

  if (data.editable) {
    const add = makeNode('form', 'team-conn-form');
    add.append(makeNode('h3', '', 'Add new API secret (saved directly to Joint Bob Secrets)'));
    const label = makeInput(add, 'Secret label', 'e.g. Personal Gmail OAuth or ElevenLabs', 'team-secret-label');
    const providerWrap = makeNode('label', 'team-field');
    providerWrap.append(makeNode('span', '', 'Provider'));
    const provider = document.createElement('select');
    for (const value of ['custom', 'google', 'elevenlabs', 'github', 'jira', 'aws', 'openai', 'cloudflare', 'stripe', 'gitlab']) {
      provider.append(new Option(value, value));
    }
    providerWrap.append(provider);
    add.append(providerWrap);
    const varName = makeInput(add, 'Environment variable name', 'e.g. GOOGLE_CREDENTIALS_JSON or ELEVENLABS_API_KEY', 'team-secret-varname');
    const varVal = makeInput(add, 'Secret value (masked — never enters chat)', 'Paste API key or JSON…', 'team-secret-value', 'password');
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary compact';
    submit.dataset.testid = 'team-secret-create';
    submit.textContent = 'Save Secret & Attach to Role';
    add.append(submit);
    add.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        await api(`${base}/secrets`, {
          method: 'POST',
          body: { label: label.value.trim(), provider: provider.value, variables: [{ name: varName.value.trim().toUpperCase(), value: varVal.value }] },
        });
        toast('Secret saved & attached');
        await reload();
      } catch (err) { toast.error(err.message); }
    });
    parent.append(add);
  }
}

function renderBrowserTab(parent, base, data, role, reload) {
  const section = makeNode('div', 'team-conn-section');
  section.append(makeNode('h3', '', `Saved browser sessions pinned to /${role} on ${data.host.name}`));
  if (!data.logins.length) {
    section.append(makeNode('p', 'team-muted', `No persistent browser login saved for /${role} yet. Start one below (e.g. WhatsApp QR or Sela SSO) — sign in right here and it stays saved for /${role}.`));
  } else {
    for (const login of data.logins) {
      const card = makeNode('div', 'team-conn-row');
      const info = makeNode('div', '');
      info.append(makeNode('strong', '', login.label), makeNode('small', 'team-muted', ` · ${login.state}${login.sites?.length ? ` · ${login.sites.join(', ')}` : ''}`));
      const actions = makeNode('div', 'team-row-actions');
      const openBtn = makeButton(`Open Live Login`, `team-login-open-${login.profileId}`, async () => {
        openBtn.disabled = true;
        try {
          const res = await api(`${base}/logins/${encodeURIComponent(login.profileId)}/open`, { method: 'POST', body: {} });
          openInlineBrowserLogin(res.session, { role, label: login.label, hostName: data.host.name, onDone: reload });
        } catch (err) { toast.error(err.message); }
        finally { openBtn.disabled = false; }
      });
      openBtn.className = 'primary compact';
      actions.append(openBtn);
      if (data.editable) {
        const detachBtn = makeButton('Detach', `team-login-detach-${login.profileId}`, async () => {
          await api(`${base}/logins/${encodeURIComponent(login.profileId)}`, { method: 'DELETE' });
          toast(`Detached ${login.label}`);
          await reload();
        });
        detachBtn.className = 'ghost compact team-wizard-secondary-btn';
        actions.append(detachBtn);
      }
      card.append(info, actions);
      section.append(card);
    }
  }
  parent.append(section);

  if (data.editable && data.savedLogins.length) {
    const attachRow = makeNode('div', 'team-conn-section');
    attachRow.append(makeNode('h3', '', `Or reuse an existing saved profile on ${data.host.name}`));
    const pick = document.createElement('select');
    for (const item of data.savedLogins) pick.append(new Option(`${item.label}${item.sites.length ? ` (${item.sites.join(', ')})` : ''}`, item.profileId));
    const btn = makeButton(`Pin to /${role}`, 'team-login-attach', async () => {
      await api(`${base}/logins/attach`, { method: 'POST', body: { profileId: pick.value } });
      toast(`Browser profile pinned to /${role}`);
      await reload();
    });
    btn.className = 'ghost compact team-wizard-secondary-btn';
    const bar = makeNode('div', 'team-inline-bar');
    bar.append(pick, btn);
    attachRow.append(bar);
    parent.append(attachRow);
  }

  if (data.editable) {
    const form = makeNode('form', 'team-conn-form');
    form.append(makeNode('h3', '', `Sign in to a website & save session for /${role}`));
    const presets = makeNode('div', 'team-preset-row');
    const label = makeInput(form, 'Session name', 'e.g. WhatsApp Web or Sela SSO', 'team-login-label');
    const url = makeInput(form, 'Sign-in URL', 'https://web.whatsapp.com', 'team-login-url', 'url');
    for (const [name, presetUrl] of [['WhatsApp Web (QR)', 'https://web.whatsapp.com'], ['Slack / Sela SSO', 'https://app.slack.com'], ['Gmail / Google', 'https://mail.google.com']]) {
      const chip = makeButton(name, `team-login-preset-${name}`, () => { label.value = name.replace(/\s*\(.+\)/, ''); url.value = presetUrl; });
      chip.className = 'ghost compact team-wizard-secondary-btn';
      presets.append(chip);
    }
    form.querySelector('h3').after(presets);
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary compact';
    submit.dataset.testid = 'team-login-start';
    submit.textContent = `Open Live Browser to Sign In →`;
    form.append(submit);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!label.value.trim() || !url.value.trim()) { toast.error('Pick a preset or enter a session name and URL.'); return; }
      submit.disabled = true;
      submit.textContent = `Starting live browser on ${data.host.name}…`;
      try {
        const started = await api(`${base}/logins`, { method: 'POST', body: { label: label.value.trim(), url: url.value.trim() } });
        openInlineBrowserLogin(started.session, { role, label: label.value.trim(), hostName: data.host.name, onDone: reload });
      } catch (err) { toast.error(err.message); }
      finally {
        submit.disabled = false;
        submit.textContent = `Open Live Browser to Sign In →`;
      }
    });
    parent.append(form);
  }
}

function renderMcpTab(parent, base, data, reload) {
  const section = makeNode('div', 'team-conn-section');
  section.append(makeNode('h3', '', 'MCP servers available to this role'));
  const allBox = document.createElement('input');
  allBox.type = 'checkbox';
  allBox.checked = data.profile.mcpServerNames === null;
  allBox.disabled = !data.editable;
  const allRow = makeNode('label', 'team-check-row');
  allRow.append(allBox, makeNode('span', '', 'Allow all installed MCP servers on this host'));
  section.append(allRow);

  const selected = new Set(data.mcpServers.filter(s => s.enabled).map(s => s.name));
  const list = makeNode('div', 'team-check-list');
  const syncBoxes = () => { for (const box of list.querySelectorAll('input')) box.disabled = !data.editable || allBox.checked; };
  for (const server of data.mcpServers) {
    const row = makeNode('label', 'team-check-row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(server.name);
    box.addEventListener('change', () => { if (box.checked) selected.add(server.name); else selected.delete(server.name); });
    const copy = makeNode('span', 'team-check-copy');
    copy.append(makeNode('strong', '', server.name), makeNode('small', 'team-muted', server.source));
    row.append(box, copy);
    list.append(row);
  }
  allBox.addEventListener('change', syncBoxes);
  syncBoxes();
  section.append(list.childNodes.length ? list : makeNode('p', 'team-muted', 'No MCP servers installed on this host.'));
  if (data.editable) {
    const save = makeButton('Save MCP access', 'team-conn-save-mcp', async () => {
      await api(`${base}/connections`, { method: 'PUT', body: { mcpServerNames: allBox.checked ? null : [...selected] } });
      toast('MCP access updated');
      await reload();
    });
    save.className = 'primary compact';
    section.append(save);
  }
  parent.append(section);
}

function renderSkillsTab(parent, base, data, reload) {
  const section = makeNode('div', 'team-conn-section');
  section.append(makeNode('h3', '', 'Tool permissions & skills'));
  const browserBox = document.createElement('input'); browserBox.type = 'checkbox'; browserBox.checked = Boolean(data.profile.allowBrowser); browserBox.disabled = !data.editable;
  const termBox = document.createElement('input'); termBox.type = 'checkbox'; termBox.checked = Boolean(data.profile.allowTerminal); termBox.disabled = !data.editable;
  const perms = makeNode('div', 'team-check-list');
  const r1 = makeNode('label', 'team-check-row'); r1.append(browserBox, makeNode('span', '', 'Allow Browser tool'));
  const r2 = makeNode('label', 'team-check-row'); r2.append(termBox, makeNode('span', '', 'Allow Terminal tool'));
  perms.append(r1, r2);
  section.append(perms);

  const disabled = new Set(data.skills.filter(s => !s.enabled).map(s => s.name));
  if (data.skills.length) {
    section.append(makeNode('h3', '', 'Installed skills'));
    const list = makeNode('div', 'team-check-list');
    for (const skill of data.skills) {
      const row = makeNode('label', 'team-check-row');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = skill.enabled;
      box.disabled = !data.editable;
      box.addEventListener('change', () => { if (box.checked) disabled.delete(skill.name); else disabled.add(skill.name); });
      const copy = makeNode('span', 'team-check-copy');
      copy.append(makeNode('strong', '', skill.name), makeNode('small', 'team-muted', skill.description || skill.origin));
      row.append(box, copy);
      list.append(row);
    }
    section.append(list);
  }
  if (data.editable) {
    const save = makeButton('Save skills & tools', 'team-conn-save-skills', async () => {
      await api(`${base}/connections`, { method: 'PUT', body: { allowBrowser: browserBox.checked, allowTerminal: termBox.checked, disabledSkills: [...disabled] } });
      toast('Skills & permissions updated');
      await reload();
    });
    save.className = 'primary compact';
    section.append(save);
  }
  parent.append(section);
}

function makeInput(parent, labelText, placeholder, testid, type = 'text') {
  const wrap = makeNode('label', 'team-field');
  wrap.append(makeNode('span', '', labelText));
  const field = document.createElement('input');
  field.type = type;
  field.placeholder = placeholder;
  field.dataset.testid = testid;
  wrap.append(field);
  parent.append(wrap);
  return field;
}
