// Automation editor → Context → Skills. Skills belong to one automation. The tab lists the skills
// set up in Resources on this machine to add directly; "+ Add skill" uploads a folder or imports from Git.
import { api } from "./api.js";
import { createFittedList, makeBadge, makeButton, makeNode, makeTwoStepButton } from "./relay-ui.js";
import { encodeFile, makeSegmented } from "./automation-ui.js";

const INVENTORY_ROWS = 5;
const MAX_FOLDER_BYTES = 4 * 1024 * 1024;

function makeInput(testid, attributes) {
  const input = document.createElement("input");
  input.dataset.testid = testid;
  Object.assign(input, attributes);
  return input;
}

function makeField(label, input) {
  const field = makeNode("label", "", label);
  field.append(input);
  return field;
}

function makeList(testid) {
  const list = makeNode("div", "relay-list");
  if (testid) list.dataset.testid = testid;
  return list;
}

/** `url(suffix)` addresses the current automation, `run(work)` runs one guarded action. */
export function createAutomationSkills({ url, run, say, onCount }) {
  let skills = [];
  let inventory = [];

  const element = makeNode("div", "automation-skills");
  const panel = makeNode("div", "automation-add-panel");
  panel.dataset.testid = "automation-skill-panel";
  panel.hidden = true;
  const methods = makeNode("div");
  const folder = makeInput("automation-skill-folder-input", { type: "file", multiple: true, hidden: true });
  folder.webkitdirectory = true;
  const uploadMethod = makeNode("div");
  uploadMethod.dataset.skillMethod = "upload";
  const dropZone = makeNode("div", "automation-drop");
  dropZone.append(
    makeNode("span", "", "A skill folder must contain SKILL.md. Files are stored as-is and never run on upload."),
    makeButton("Choose folder…", "automation-skill-choose-button", () => folder.click()),
    folder,
  );
  uploadMethod.append(dropZone);
  const gitUrl = makeInput("automation-skill-git-url-input", { maxLength: 2048, placeholder: "https://github.com/org/repo.git" });
  const gitRef = makeInput("automation-skill-git-ref-input", { maxLength: 200, placeholder: "main" });
  const gitResults = makeList();
  const gitMethod = makeNode("div");
  gitMethod.dataset.skillMethod = "git";
  gitMethod.hidden = true;
  const gitForm = makeNode("div", "relay-form");
  gitForm.append(makeField("Repository URL", gitUrl), makeField("Branch or tag (optional)", gitRef));
  gitMethod.append(gitForm, makeButton("Find skills", "automation-skill-git-discover-button", () => void run(findInGit)), gitResults);
  const panelHead = makeNode("div", "relay-head");
  panelHead.append(methods, makeButton("Close", "automation-skill-close-button", () => { panel.hidden = true; }));
  panel.append(panelHead, uploadMethod, gitMethod);

  const intro = makeNode("div", "relay-head");
  intro.append(
    makeNode("p", "settings-hint", "Skills only this automation's agent can use. They are not added anywhere else. Imports are stored as inert files and never run or installed."),
    makeButton("+ Add skill", "automation-skill-add-button", () => { panel.hidden = false; }, "primary compact"),
  );
  const listNode = makeList("automation-skill-list");
  const pagerNode = makeNode("div", "relay-pager");
  pagerNode.dataset.testid = "automation-skill-pager";
  pagerNode.hidden = true;
  const availableCount = makeNode("span");
  const availableTitle = makeNode("h4", "", "Available in Resources ");
  availableTitle.append(availableCount);
  const search = makeInput("automation-skill-search-input", { type: "search", placeholder: "Search skills in Resources…" });
  search.setAttribute("aria-label", "Search skills in Resources");
  const inventoryList = makeList("automation-skill-inventory");
  const available = makeNode("section", "automation-available");
  available.dataset.testid = "automation-skill-available";
  available.append(availableTitle, makeNode("p", "settings-hint", "Skills set up in Resources on this machine. Add one to copy it into this automation."), search, inventoryList);
  element.append(intro, panel, listNode, pagerNode, available);

  const list = createFittedList({
    list: listNode, pager: pagerNode, testPrefix: "automation-skills",
    emptyText: "No skills yet. Add one from Resources below, a folder or Git.",
    fetchPage: async (page, size) => ({ total: skills.length, items: skills.slice((page - 1) * size, page * size) }),
    renderItem: skillRow,
  });

  async function reload() {
    [skills, inventory] = (await Promise.all([api(url("/skills")), api(url("/skills?inventory=1"))])).map((body) => body.skills);
    onCount(skills.length);
    renderInventory();
    await list.reload();
  }

  const post = (body) => api(url("/skills"), { method: "POST", body: JSON.stringify(body) });
  const add = (body, after) => run(async () => { await post(body); await reload(); await after?.(); });

  function sourceLabel(skill) {
    if (skill.source !== "git") return skill.source;
    return `Git · ${skill.sourceUrl}${skill.sourceCommit ? ` @ ${skill.sourceCommit.slice(0, 7)}` : ""}`;
  }

  async function updateFromGit(skill) {
    const source = await post({ action: "discover-git", url: skill.sourceUrl, ref: skill.sourceRef ?? null });
    if (!source.skills.some((item) => item.key === skill.sourceKey)) throw new Error("This skill is no longer available at the selected Git ref");
    if (source.commit === skill.sourceCommit) { say("This skill is already current."); return; }
    await post({ action: "import-git", url: skill.sourceUrl, ref: skill.sourceRef ?? null, commit: source.commit, key: skill.sourceKey, skillId: skill.id });
    await reload();
    say("Git skill updated.", "ok");
  }

  function skillRow(skill) {
    const row = makeNode("div", "relay-row");
    const main = makeNode("div", "relay-row-main");
    const title = makeNode("div", "relay-row-title");
    title.append(makeNode("strong", "relay-row-name", skill.name), makeBadge(sourceLabel(skill)));
    main.append(title, makeNode("p", "relay-row-meta", skill.description));
    const actions = makeNode("div", "relay-row-actions");
    if (skill.source === "git" && skill.sourceUrl && skill.sourceKey) actions.append(makeTwoStepButton({ label: "Update from Git", armedLabel: "Update to latest?", testid: "automation-git-skill-update-button", onConfirm: () => run(() => updateFromGit(skill)) }));
    actions.append(makeButton("Remove", "automation-skill-remove-button", () => void run(async () => {
      await api(url(`/skills/${skill.id}`), { method: "DELETE" });
      await reload();
    })));
    row.append(main, actions);
    return row;
  }

  function pickRow(name, detail, action) {
    const row = makeNode("div", "relay-row relay-row-compact");
    row.append(makeNode("div", "relay-row-main", `${name} · ${detail}`), action);
    return row;
  }

  /** One entry per skill name: the same skill set up for several harnesses is listed and added once. */
  function renderInventory() {
    const query = search.value.trim().toLowerCase();
    const unique = [...new Map(inventory.map((skill) => [skill.name, skill])).values()];
    const matches = unique.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query));
    const rows = matches.slice(0, INVENTORY_ROWS).map((skill) => {
      const added = skills.some((item) => item.source === "existing" && item.name === skill.name);
      const action = added ? makeBadge("Added", "ok") : makeButton("Add", "automation-skill-import-existing-button", () => void add({ action: "import-existing", inventoryId: skill.inventoryId }));
      return pickRow(skill.name, skill.description, action);
    });
    availableCount.textContent = unique.length ? `(${unique.length})` : "";
    if (!unique.length) rows.push(makeNode("p", "relay-empty", "No skills in Resources on this machine. Upload a folder or use Git."));
    else if (!matches.length) rows.push(makeNode("p", "relay-empty", "No skills match."));
    if (matches.length > INVENTORY_ROWS) rows.push(makeNode("p", "relay-empty", `${matches.length - INVENTORY_ROWS} more. Search to narrow the list.`));
    inventoryList.replaceChildren(...rows);
  }

  async function uploadFolder(files) {
    let total = 0;
    const encoded = [];
    for (const file of files) {
      total += file.size;
      if (total > MAX_FOLDER_BYTES) throw new Error("A skill folder must be at most 4 MiB");
      encoded.push({ relativePath: file.webkitRelativePath?.split("/").slice(1).join("/") || file.name, data: await encodeFile(file) });
    }
    await post({ action: "upload", files: encoded });
    await reload();
  }

  function showGitResults(found, gitUrl, ref) {
    const rows = found.skills.map((skill) => {
      const added = skills.some((item) => item.sourceKey === skill.key && item.sourceUrl === gitUrl);
      const action = added ? makeBadge("Added", "ok") : makeButton("Add", "automation-git-skill-import-button", () => void add({ action: "import-git", url: gitUrl, ref, commit: found.commit, key: skill.key }, () => showGitResults(found, gitUrl, ref)));
      return pickRow(skill.name, skill.description, action);
    });
    if (!rows.length) rows.push(makeNode("p", "relay-empty", "No skills found at this ref."));
    gitResults.replaceChildren(...rows);
  }

  async function findInGit() {
    const gitUrl = gitUrl.value.trim();
    if (!gitUrl) throw new Error("Enter a Git repository URL");
    const ref = gitRef.value.trim() || null;
    showGitResults(await post({ action: "discover-git", url: gitUrl, ref }), gitUrl, ref);
  }

  function showMethod(method) {
    for (const section of panel.querySelectorAll("[data-skill-method]")) section.hidden = section.dataset.skillMethod !== method;
  }

  methods.append(makeSegmented([
    { value: "upload", label: "Upload a folder", testid: "automation-skill-method-upload" },
    { value: "git", label: "From Git", testid: "automation-skill-method-git" },
  ], "upload", showMethod));
  search.addEventListener("input", renderInventory);
  folder.addEventListener("change", () => {
    const files = [...folder.files];
    folder.value = "";
    if (files.length) void run(() => uploadFolder(files));
  });

  return {
    element,
    async open(automation) {
      panel.hidden = true;
      gitResults.replaceChildren();
      if (automation) await reload();
      else { skills = []; inventory = []; onCount(0); renderInventory(); }
    },
  };
}
