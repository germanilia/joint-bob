import { api as request } from './api.js';
const api = (path, options = {}) => request(path, { ...options, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
import { makeNode, makeButton } from './relay-ui.js';
import { qrSvg } from './qr.js';

const challenges = new Map();
export async function renderTeamTelegram(parent, base, fail, refresh) {
  const status = await api(`${base}/telegram`);
  const panel = makeNode('div', 'team-telegram');
  const run = fn => () => Promise.resolve().then(fn).catch(fail);
  const redraw = async () => {
    const summary = parent.querySelector('summary');
    const open = parent.open;
    parent.replaceChildren(summary);
    parent.open = open;
    await renderTeamTelegram(parent, base, fail, refresh);
  };
  panel.append(makeNode('p', '', status.visibility), makeNode('p', '', status.confidentiality));
  if (!status.connected) {
    const label = makeNode('label', 'team-field', 'Team bot token');
    const token = makeNode('input'); token.type = 'password'; token.autocomplete = 'new-password'; token.dataset.testid = 'team-token';
    label.append(token); panel.append(label);
    panel.append(makeButton('Connect bot', 'team-connect', run(async () => {
      let value = token.value; token.value = '';
      try { await api(`${base}/telegram/connect`, { method: 'POST', body: { token: value } }); await redraw(); }
      finally { value = ''; }
    })));
  } else {
    panel.append(makeNode('p', '', `@${status.botUsername} · ${status.ready ? 'Ready' : 'Not ready'}`));
    panel.append(makeButton('Refresh visibility', 'team-telegram-refresh', run(() => api(`${base}/telegram/refresh`, { method: 'POST', body: {} }))));
    const enrollment = makeNode('div');
    const drawChallenge = issued => {
      enrollment.replaceChildren();
      if (Date.parse(issued.expiresAt) <= Date.now()) { enrollment.append(makeNode('p', '', 'Enrollment expired. Create a new link.')); return; }
      if (!issued.link) { enrollment.append(makeNode('p', '', `Send /bind ${issued.code} in the group, then confirm here. Expires ${issued.expiresAt}.`)); return; }
      const qr = qrSvg(issued.link, 'Open team enrollment in Telegram'); qr.dataset.testid = 'team-enrollment-qr';
      const link = makeNode('a', '', 'Open enrollment'); link.href = issued.link; link.dataset.testid = 'team-enrollment-link';
      const expiry = makeNode('p', '', `Expires ${new Date(issued.expiresAt).toLocaleString()}`);
      enrollment.append(qr, link, expiry);
      setTimeout(() => { if (expiry.isConnected) { expiry.textContent = 'Enrollment expired. Create a new link.'; qr.remove(); link.remove(); } }, Math.max(0, Date.parse(issued.expiresAt) - Date.now()));
    };
    if (challenges.has(base)) drawChallenge(challenges.get(base));
    panel.append(makeButton('Enroll my Telegram identity', 'team-enroll', run(async () => {
      const issued = await api(`${base}/telegram/enrollment`, { method: 'POST', body: {} });
      challenges.set(base, issued); await redraw();
    })), enrollment);
    panel.append(makeButton('Bind group', 'team-group', run(async () => {
      const issued = await api(`${base}/telegram/group`, { method: 'POST', body: {} });
      challenges.set(base, issued); await redraw();
    })));
  }
  for (const pending of status.pending) {
    const expired = Number(pending.expiresAt) <= Date.now();
    const row = makeNode('p', '', `${pending.kind}: ${pending.name ?? ''} ${pending.target ?? ''} · ${expired ? 'Expired — create a new challenge' : 'Pending your same-account confirmation'}`);
    if (!expired) row.append(makeButton('Confirm this identity', 'team-enrollment-confirm', run(() => api(`${base}/telegram/${pending.kind === 'member' ? 'enrollment' : 'group'}/${encodeURIComponent(pending.id)}/confirm`, { method: 'POST', body: {} }))));
    panel.append(row);
  }
  for (const member of status.members ?? []) panel.append(makeNode('p', '', `Enrolled: ${member.name} (${member.telegramId})`));
  for (const group of status.groups ?? []) panel.append(makeNode('p', '', `Bound group: ${group.chatId}`));
  parent.append(panel);
}
