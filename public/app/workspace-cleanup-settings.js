import { api } from './api.js';
import { confirmAction } from './shell.js';

const panel = document.querySelector('#settingsPanel-workspace-cleanup');
const enabled = panel.querySelector('#workspaceCleanupEnabled');
const status = panel.querySelector('#workspaceCleanupStatus');
const preview = panel.querySelector('#workspaceCleanupPreview');
const run = panel.querySelector('#workspaceCleanupRun');
const list = panel.querySelector('#workspaceCleanupResults');
let busy = false;
let loaded = false;
const base = '/api/workspace-cleanup';
const post = (action, payload) => api(`${base}/${action}`, { method: 'POST', body: JSON.stringify(payload) });

function nodeText(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function render(view) {
  enabled.checked = view.enabled;
  list.replaceChildren();
  for (const node of view.nodes) {
    const section = document.createElement('section');
    section.className = 'relay-section';
    section.append(nodeText('h3', node.name));
    section.append(nodeText('p', node.error || (node.lastRun ? `Last run: ${new Date(node.lastRun.finishedAt).toLocaleString()}` : 'No cleanup run yet.')));
    if (node.enabled !== undefined && node.enabled !== view.enabled) section.append(nodeText('p', 'This machine has not received the latest setting.'));
    const rows = node.rows ?? node.lastRun?.rows ?? [];
    if (rows.length) {
      const items = document.createElement('ul');
      for (const row of rows) items.append(nodeText('li', `${row.projectName} / ${row.name}: ${row.status === 'kept' ? 'Kept. ' : row.status === 'removed' ? 'Removed. ' : ''}${row.detail}`));
      section.append(items);
    } else if (node.rows) section.append(nodeText('p', 'No workspaces to check.'));
    if (node.saved?.length) section.append(nodeText('h4', 'Saved Git changes'));
    for (const entry of node.saved ?? []) {
      const row = document.createElement('p');
      const button = nodeText('button', 'Restore');
      button.type = 'button';
      button.className = 'ghost compact';
      button.addEventListener('click', () => update('Restoring a new worktree…', async () => {
        const result = await post('restore', { nodeId: node.id, projectId: entry.projectId, ref: entry.ref });
        if (result.error) throw new Error(result.error);
        status.textContent = `Created ${result.restored}. Saved Git changes are still available.`;
      }));
      row.append(nodeText('span', `${entry.name} · ${new Date(entry.savedAt).toLocaleString()} `), button);
      section.append(row);
    }
    list.append(section);
  }
}

async function update(message, action) {
  if (busy) return;
  busy = true;
  for (const field of [enabled, preview, run]) field.disabled = true;
  status.textContent = message;
  try { await action(); if (status.textContent === message) status.textContent = ''; }
  catch (error) { status.textContent = error.message; }
  finally {
    busy = false;
    for (const field of [enabled, preview, run]) field.disabled = !loaded;
  }
}

export function loadWorkspaceCleanupSettings() {
  return update('Loading workspace cleanup…', async () => { render(await api(base)); loaded = true; });
}
enabled.addEventListener('change', () => {
  const value = enabled.checked;
  void update('Saving automatic cleanup…', async () => {
    try { await api(base, { method: 'PUT', body: JSON.stringify({ enabled: value }) }); }
    catch (error) { enabled.checked = !value; throw error; }
  });
});
preview.addEventListener('click', () => update('Checking workspaces without removing files…', async () => render(await post('preview', {}))));
run.addEventListener('click', async () => {
  if (busy || !await confirmAction({ eyebrow: 'Workspace cleanup', title: 'Run workspace cleanup now?', message: 'Eligible worktrees will be removed. Unmerged changes will be saved in Git first. Conversation history stays available.', confirmLabel: 'Run cleanup', destructive: true })) return;
  await update('Running workspace cleanup…', async () => render(await post('run', { confirm: true })));
});
