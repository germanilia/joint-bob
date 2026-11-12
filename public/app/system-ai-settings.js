import { api } from './api.js';
import { isNodeAdmin } from './node-admin.js';

const panel = document.querySelector('#settingsPanel-system-ai');
// Move the existing controls, retaining their IDs, listeners and save semantics.
for (const id of ['settingsBackgroundAgentHarness', 'settingsSyncCheckHarness', 'settingsDashboardsHarness', 'settingsSummaryWriter']) {
  panel.append(document.getElementById(id).closest('fieldset'));
}
const host = document.querySelector('#systemAiChoices');
const status = document.querySelector('#systemAiStatus');
let ready = false, loading = false, saving = false, values;

function fieldset(title) {
  const box = document.createElement('fieldset'); box.className = 'phase-settings';
  const legend = document.createElement('legend'); legend.textContent = title; box.append(legend); host.append(box); return box;
}
function label(box, text, control) {
  const node = document.createElement('label'); node.append(text, control); box.append(node); return control;
}
function select(box, text, testid, options, current) {
  const control = document.createElement('select'); control.dataset.testid = testid;
  if (current && !options.some(([id]) => id === current)) options = [...options, [current, `${current} (unavailable on this twin)`]];
  control.replaceChildren(...options.map(([id, name]) => new Option(name, id))); control.value = current ?? '';
  return label(box, text, control);
}

function checkbox(box, text, testid, checked) {
  const control = document.createElement('input'); control.type = 'checkbox'; control.dataset.testid = testid; control.checked = checked;
  const node = document.createElement('label'); node.className = 'checkbox-row'; node.append(control, text); box.append(node); return control;
}
function paragraph(box, text, testid) {
  const node = document.createElement('p'); node.className = 'settings-hint'; node.textContent = text; node.dataset.testid = testid; box.append(node); return node;
}
/** Model routing: the machine-wide switch, where decisions come from and the shipped defaults (read-only).
    Returns the value to save. */
function renderRouting(routing) {
  const box = fieldset('Model routing');
  paragraph(box, 'Bob auto picks a model good enough for the job on the conversation\'s own agent: subscription before API, then the cheapest. Scores come from public evals and ship with each release.', 'system-ai-routing-hint');
  const enabled = checkbox(box, 'Route prompts with the Joint Bob default on this machine', 'system-ai-routing-enabled', routing.enabled);
  const share = routing.servesRelay ? checkbox(box, 'Let machines on this relay use this decision model', 'system-ai-routing-share', routing.shareWithRelay) : null;
  paragraph(box, routing.source, 'system-ai-routing-source');
  paragraph(box, `Defaults reviewed ${routing.defaults.reviewedAt}${routing.defaults.notes ? ` · ${routing.defaults.notes}` : ''}`, 'system-ai-routing-reviewed');
  const list = document.createElement('dl'); list.className = 'system-ai-routing-defaults'; list.dataset.testid = 'system-ai-routing-defaults';
  for (const category of routing.defaults.categories) {
    const term = document.createElement('dt'); term.textContent = category.description; list.append(term);
    for (const [harness, candidates] of Object.entries(category.candidates)) {
      const detail = document.createElement('dd');
      detail.textContent = `${harness}: ${candidates.map(item => [item.provider, item.modelId, item.thinkingLevel, item.billing, item.score === undefined ? '' : `score ${item.score}`].filter(Boolean).join(' · ')).join(' → ')}`;
      list.append(detail);
    }
  }
  const models = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Default models, in the order they are tried';
  models.append(summary, list); box.append(models);
  return () => ({ enabled: enabled.checked, shareWithRelay: share ? share.checked : routing.shareWithRelay });
}

export async function loadSystemAiSettings(bridge) {
  if (!isNodeAdmin() || loading || saving) return;
  loading = true; ready = false; status.textContent = 'Loading…';
  try {
    const [view, catalog, personal] = await Promise.all([api('/api/system-ai'), api('/api/harnesses'), api('/api/settings')]);
    host.replaceChildren();
    document.querySelector('#systemAiNode').textContent = `Execution machine: ${view.node.name} (${view.node.id}). Readiness is local to this machine.`;
    document.querySelector('#systemAiReadiness').textContent = view.readiness.decision;
    const descriptors = catalog.harnesses.filter(item => item.configuration);
    for (const choice of [view.backgroundAgent, view.syncCheck, view.dashboards, ...Object.values(view.system.operations)]) {
      if (choice?.harnessId && !descriptors.some(item => item.id === choice.harnessId)) descriptors.push({ id: choice.harnessId, label: `${choice.harnessId} (unavailable on this twin)`, runtimeConfigured: false, configuration: { thinkingLevels: [choice.thinkingLevel || 'default'] } });
    }
    const defaults = Object.fromEntries(descriptors.map(item => [item.id, personal.conversationDefaults?.[item.id] ?? { provider: item.configuration.fixedProvider ?? '', modelId: '', thinkingLevel: 'default' }]));
    const settings = { ...view, conversationDefaults: defaults };
    bridge.render(settings, descriptors);
    const decision = fieldset('System decision');
    const model = select(decision, 'Decision model', 'system-ai-decision-model', [['typesafe', 'TypeSafe'], ['laya', 'Laya']], view.system.decision.model);
    const accounts = name => [['', name === 'TYPESAFE_AI_API_KEY' ? 'Automatic only when one system account is available' : 'No key (local Laya)'], ...view.secrets.filter(item => item.variables.some(variable => variable.name === name && variable.configured)).map(item => [item.id, item.label])];
    const typesafe = select(decision, 'TypeSafe secret account', 'system-ai-typesafe-account', accounts('TYPESAFE_AI_API_KEY'), view.system.decision.typesafeAccountId);
    const laya = select(decision, 'Laya secret account', 'system-ai-laya-account', accounts('LAYA_API_KEY'), view.system.decision.layaAccountId);
    const routing = renderRouting(view.routing);
    const operations = {};
    for (const [key, title] of [['knowledge', 'Knowledge cleanup']]) {
      const box = fieldset(title);
      const saved = view.system.operations[key];
      const harness = select(box, 'Agent override', `system-ai-${key}-harness`, [['', 'Existing summary-writer behavior (no override)'], ...descriptors.map(item => [item.id, item.label])], saved?.harnessId);
      const controls = document.createElement('div'); box.append(controls);
      let fields = null, descriptor;
      function render() {
        descriptor = descriptors.find(item => item.id === harness.value);
        fields = null; controls.replaceChildren();
        if (!descriptor) return;
        const picker = bridge.controls(descriptor, settings, '', { current: saved?.harnessId === harness.value ? saved : defaults[harness.value], idPrefix: `systemAi${key}`, testPrefix: `system-ai-${key}`, label: title });
        fields = picker.fields; controls.append(...picker.controls);
      }
      harness.onchange = render; render();
      operations[key] = () => !harness.value ? null : fields ? { harnessId: harness.value, provider: fields.provider ? fields.provider.value : descriptor.configuration.fixedProvider, modelId: fields.model.value, thinkingLevel: fields.thinking.value } : saved;
    }
    const profiles = fieldset('System login profiles');
    const profileControls = {};
    for (const key of ['claude', 'pi', 'kiro', 'openai-codex']) {
      profileControls[key] = select(profiles, key, `system-ai-profile-${key}`, [['', 'Existing sign-in selection'], ...view.profiles.filter(item => item.provider === key).map(item => [item.id, item.label])], view.system.profiles[key]);
    }
    values = () => ({ system: { decision: { model: model.value, typesafeAccountId: typesafe.value || null, layaAccountId: laya.value || null }, operations: { ...view.system.operations, ...Object.fromEntries(Object.entries(operations).map(([key, get]) => [key, get()])) }, quality: view.system.quality, profiles: Object.fromEntries(Object.entries(profileControls).map(([key, control]) => [key, control.value || null])), routing: routing() }, ...bridge.value() });
    ready = true; status.textContent = '';
  } catch (error) { status.textContent = error.message; }
  finally { loading = false; }
}

/** Saves as the fields change (settings.js); a failure is thrown so the Settings save line shows it. */
export async function saveSystemAiSettings() {
  if (!isNodeAdmin()) return;
  if (!ready || loading) throw Object.assign(new Error('System AI settings are still loading'), { invalidSetting: true });
  saving = true; status.textContent = 'Saving…';
  try {
    const saved = await api('/api/system-ai', { method: 'PUT', body: JSON.stringify(values()) });
    document.querySelector('#systemAiReadiness').textContent = saved.readiness.decision;
    status.textContent = 'Saved · shared with trusted twins. Readiness is machine-local.';
  } catch (error) { status.textContent = error.message; throw error; }
  finally { saving = false; }
}
