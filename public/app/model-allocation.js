import { api } from "./api.js";

/** One element with its text, test id and plain properties; the app never builds markup from strings. */
function el(tag, { text, testid, role, ...properties } = {}) {
  const node = Object.assign(document.createElement(tag), properties);
  if (text !== undefined) node.textContent = text;
  if (testid) node.dataset.testid = testid;
  if (role) node.setAttribute("role", role);
  return node;
}

function labelled(text, control) {
  const label = el("label", { text });
  label.append(control);
  return label;
}

function advancedDetails() {
  const details = el("details");
  details.append(
    el("summary", { text: "Candidate estimates and benchmark snapshots" }),
    el("p", { text: "Advanced preview: enter a JSON array of candidates with exact identity, capabilities and cost estimates. The first candidate is the baseline. Unknown costs must be null, not zero. Include no credentials. History is loaded only from your accessible projects on this machine." }),
    labelled("Candidate estimates", el("textarea", { testid: "allocation-candidates", rows: 6, maxLength: 100000, spellcheck: false, value: "[]" })),
    labelled("Verified benchmark snapshots (optional)", el("textarea", { testid: "allocation-evidence", rows: 3, maxLength: 200000, spellcheck: false, value: "[]" })),
  );
  return details;
}

function pinnedChoice() {
  const label = el("label");
  label.append(el("input", { type: "checkbox", testid: "allocation-pinned", checked: true }), " Keep manual baseline selection");
  return label;
}

function resultLine() {
  const result = el("p", { testid: "allocation-result", role: "status" });
  result.style.whiteSpace = "pre-wrap";
  result.style.overflowWrap = "anywhere";
  return result;
}

function pagerButtons() {
  const row = el("div");
  row.append(el("button", { type: "button", testid: "allocation-previous", hidden: true, text: "Previous" }), " ", el("button", { type: "button", testid: "allocation-next", hidden: true, text: "Next" }));
  return row;
}

/** An explicit, read-only preview. No polling, browser storage, or automatic model switch. */
export async function renderAllocationPreview() {
  if (document.querySelector('[data-testid="allocation-preview"]')) return;
  const section = document.createElement("section");
  section.dataset.testid = "allocation-preview";
  section.className = "routing-config-editor";
  section.append(
    el("h3", { text: "Evidence-based allocation preview" }),
    el("p", { testid: "allocation-status", role: "status", text: "Loading evidence availability…" }),
    el("p", { text: "Recommendation only. Existing routing and manual choices stay unchanged. Automatic recovery remains disabled until held-out acceptance and a finite approved allowance." }),
    labelled("Task description", el("textarea", { testid: "allocation-task", rows: 3, maxLength: 12000 })),
    el("button", { type: "button", testid: "allocation-assess", text: "Assess with configured decision model" }),
    el("p", { testid: "allocation-assessment", role: "status" }),
    advancedDetails(),
    pinnedChoice(),
    el("button", { type: "button", testid: "allocation-compare", text: "Preview recommendation" }),
    resultLine(),
    pagerButtons(),
  );
  document.querySelector("#settingsPanel-classifiers").append(section);
  const field = name => section.querySelector(`[data-testid="allocation-${name}"]`);
  let assessment = null;
  let lines = [], page = 0;
  const show = () => {
    field("result").textContent = lines.slice(page * 5, page * 5 + 5).join("\n");
    field("previous").hidden = page === 0;
    field("next").hidden = (page + 1) * 5 >= lines.length;
  };
  field("previous").onclick = () => { page--; show(); };
  field("next").onclick = () => { page++; show(); };
  field("task").oninput = () => { assessment = null; field("assessment").textContent = "Task changed; assess it again before comparing."; };
  field("assess").onclick = async () => {
    field("assess").disabled = true;
    assessment = null;
    try {
      const result = await api("/api/routing-configs/allocation/assess", { method: "POST", body: JSON.stringify({ taskId: crypto.randomUUID(), text: field("task").value, capabilities: [] }) });
      assessment = result.assessment;
      field("assessment").textContent = `${assessment.domain} · complexity ${assessment.complexity}/10 · ${assessment.risk} risk · confidence ${Math.round(assessment.confidence * 100)}%`;
    } catch (error) { field("assessment").textContent = error.message; }
    finally { field("assess").disabled = false; }
  };
  field("compare").onclick = async () => {
    field("compare").disabled = true;
    try {
      if (!assessment) throw new Error("Assess the task first.");
      const candidates = JSON.parse(field("candidates").value);
      if (!Array.isArray(candidates) || !candidates.length) throw new Error("Provide at least one candidate with an exact identity and cost estimates.");
      const result = await api("/api/routing-configs/allocation/preview", { method: "POST", body: JSON.stringify({ assessment, baseline: candidates[0].identity, pinned: field("pinned").checked, candidates, evidence: JSON.parse(field("evidence").value) }) });
      lines = [result.reason, ...result.ranked.map(row => `${row.identity.harness}/${row.identity.modelId}: estimated $${row.expectedCost.toFixed(4)}, ${row.samples} local tasks, conservative quality ${(row.lowerBound * 100).toFixed(1)}%, benchmark age ${row.benchmarkAgeDays === null ? "unknown" : `${Math.round(row.benchmarkAgeDays)} days`}. ${row.uncertainty}`), ...result.excluded.map(row => `${row.identity.modelId}: ${row.reason}`), result.notice];
      page = 0; show();
    } catch (error) { lines = [error.message]; page = 0; show(); }
    finally { field("compare").disabled = false; }
  };
  try {
    const status = await api("/api/routing-configs/allocation");
    field("status").textContent = `Recommendation-only · ${status.observations} derived local observations. ${status.explanation}`;
  } catch (error) { field("status").textContent = `Could not load allocation evidence: ${error.message}`; }
}
