// Automation editor → Context tab: secret accounts (saved with the automation) and Files & tools,
// Skills and Memory (applied at once through their own endpoints, so they need a saved automation;
// files may also be staged before it is created). The segments load lazily the first time they open.
import { api } from "./api.js";
import { createAutomationFiles } from "./automation-files.js";
import { createAutomationMemory } from "./automation-memory.js";
import { createAutomationSkills } from "./automation-skills.js";
import { makeButton, makeNode } from "./relay-ui.js";
import { makeSegmented } from "./automation-ui.js";

const SECRET_ROWS = 8;
const CREATE_FIRST = "Create the automation first, then add files, skills and memory.";
const SEGMENTS = [
  { value: "accounts", label: "Secret accounts" },
  { value: "files", label: "Files & tools" },
  { value: "skills", label: "Skills" },
  { value: "memory", label: "Memory" },
];

export function createContextTab(ctx) {
  let selected = new Set();
  let page = 1;
  let segment = "accounts";
  let createdItem = null;
  const counts = { files: 0, skills: 0, memory: false };
  const loaded = new Set();

  const report = (change) => { Object.assign(counts, change); ctx.setCounts?.({ ...counts }); };
  const filesUrl = (suffix) => ctx.endpoint(`/${(createdItem ?? ctx.state.item).id}${suffix}`);
  const files = createAutomationFiles({ url: filesUrl, run: ctx.run, onCount: (files) => report({ files }) });
  const skills = createAutomationSkills({ url: ctx.url, run: ctx.run, say: ctx.say, onCount: (skills) => report({ skills }) });
  const memory = createAutomationMemory({ url: ctx.url, run: ctx.run, say: ctx.say, onEnabled: (memory) => report({ memory }) });

  // ---- secret accounts ----

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search accounts…";
  search.dataset.testid = "automation-secret-search-input";
  search.setAttribute("aria-label", "Search secret accounts");
  const secretList = makeNode("div", "relay-list");
  secretList.dataset.testid = "automation-secret-accounts";
  const secretPager = makeNode("div", "relay-pager");
  secretPager.dataset.testid = "automation-secrets-pager";
  const accountsPanel = makeNode("div", "automation-panel");
  accountsPanel.append(
    makeNode("p", "settings-hint", "Project and workspace secrets come automatically. Picked accounts are added to each run's conversation."),
    search, secretList, secretPager,
  );

  function renderSecrets() {
    const available = ctx.state.options.secretAccounts.filter((account) => !account.projectId || account.projectId === ctx.state.projectId);
    const unavailable = [...selected].filter((id) => !available.some((account) => account.id === id)).map((id) => ({ id, label: "Unavailable account. Remove to save." }));
    const query = search.value.trim().toLowerCase();
    const matches = [...unavailable, ...available].filter((account) => `${account.label} ${account.provider ?? ""}`.toLowerCase().includes(query));
    const pages = Math.max(1, Math.ceil(matches.length / SECRET_ROWS));
    page = Math.min(page, pages);
    const rows = matches.slice((page - 1) * SECRET_ROWS, page * SECRET_ROWS).map((account) => {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = account.id;
      input.checked = selected.has(account.id);
      input.dataset.testid = "automation-secret-account-checkbox";
      input.addEventListener("change", () => {
        if (input.checked) selected.add(account.id); else selected.delete(account.id);
        ctx.markDirty();
      });
      const row = makeNode("label", "checkbox-row automation-pick");
      row.append(input, makeNode("span", "automation-pick-name", account.label));
      if (account.provider) row.append(makeNode("span", "automation-pick-meta", account.provider));
      return row;
    });
    if (!matches.length) rows.push(makeNode("p", "settings-hint", ctx.state.options.secretAccounts.length ? "No accounts match." : "No secret accounts available. Add accounts in Settings → Secrets on the automation's owner machine."));
    secretList.replaceChildren(...rows);
    secretPager.hidden = pages === 1;
    const previous = makeButton("Previous", "automation-secrets-page-previous", () => { page -= 1; renderSecrets(); });
    previous.disabled = page <= 1;
    const next = makeButton("Next", "automation-secrets-page-next", () => { page += 1; renderSecrets(); });
    next.disabled = page >= pages;
    const label = makeNode("span", "", `${(page - 1) * SECRET_ROWS + 1}–${Math.min(matches.length, page * SECRET_ROWS)} of ${matches.length}`);
    label.dataset.testid = "automation-secrets-page-label";
    secretPager.replaceChildren(previous, label, next);
  }

  search.addEventListener("input", () => { page = 1; renderSecrets(); });

  // ---- files, skills, memory ----

  const createFirst = (child) => {
    const hint = makeNode("p", "settings-hint", CREATE_FIRST);
    const panel = makeNode("div", "automation-panel");
    panel.append(hint, child.element);
    return { panel, hint, child };
  };
  const filesNote = makeNode("p", "settings-hint", "Files added now upload when the automation is created.");
  const filesPanel = makeNode("div", "automation-panel");
  filesPanel.append(filesNote, files.element);
  const skillsPart = createFirst(skills);
  const memoryPart = createFirst(memory);
  const panels = { accounts: accountsPanel, files: filesPanel, skills: skillsPart.panel, memory: memoryPart.panel };
  const loaders = { files, skills, memory };

  function applyItem(saved) {
    filesNote.hidden = saved;
    for (const part of [skillsPart, memoryPart]) {
      part.hint.hidden = saved;
      part.child.element.hidden = !saved;
    }
  }

  /** Loads the open segment once, with its panel inert so nothing is clicked half-loaded. */
  async function loadSegment() {
    const loader = loaders[segment];
    if (!loader || !ctx.state.item || loaded.has(segment)) return;
    const name = segment;
    const panel = panels[name];
    await ctx.run(async () => {
      panel.inert = true;
      ctx.say(`Loading ${SEGMENTS.find((entry) => entry.value === name).label.toLowerCase()}…`);
      try {
        await loader.open(ctx.state.item);
        loaded.add(name);
        ctx.say("");
      } finally {
        panel.inert = false;
      }
    });
  }

  function showSegment(next) {
    segment = next;
    for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== next;
    void loadSegment();
  }

  const switcher = makeSegmented(SEGMENTS.map((entry) => ({ ...entry, testid: `automation-context-segment-${entry.value}` })), "accounts", showSegment);
  const element = makeNode("div", "automation-context");
  element.append(makeNode("p", "settings-hint", "What the agent gets on every run, whatever started it."), switcher, ...Object.values(panels));
  for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== segment;

  return {
    element,
    fill(item) {
      selected = new Set(item?.secretAccountIds ?? []);
      search.value = "";
      page = 1;
      createdItem = null;
      loaded.clear();
      report({ files: 0, skills: 0, memory: false });
      renderSecrets();
      applyItem(item !== null);
      // A new automation starts with an empty file stage; a saved one loads when its segment is open.
      if (item === null) void files.open(null);
      else if (element.offsetParent) void loadSegment();
    },
    read: () => ({ secretAccountIds: [...selected] }),
    onShow: () => loadSegment(),
    onNode: renderSecrets,
    /** The first staged file that cannot be uploaded yet, as a sentence for the save check, or null. */
    missingStaged: () => files.missing()?.message ?? null,
    /** Right after the automation is created: its staged files upload. Throws on the first failure. */
    async uploadStagedFiles(created) {
      createdItem = created;
      loaded.add("files");
      files.attach(created);
      try {
        await files.uploadStaged();
      } finally {
        createdItem = null;
      }
    },
  };
}
