import { api } from "./api.js";

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

function allocationFields() {
  const mode = el("select", { testid: "allocation-mode", disabled: true });
  for (const [value, text] of [["off", "Off"], ["recommendation", "Record recommendations"], ["automatic", "Automatic after validation"]]) mode.append(el("option", { value, text }));
  const details = el("details");
  details.append(
    el("summary", { text: "Candidate estimates and benchmark snapshots" }),
    el("p", { text: "Advanced preview: enter a JSON array of candidates with exact identity, capabilities and cost estimates. The first candidate is the baseline. Unknown costs must be null, not zero. Include no credentials. History is loaded only from your accessible projects on this machine." }),
    labelled("Candidate estimates", el("textarea", { testid: "allocation-candidates", rows: 6, maxLength: 100000, spellcheck: false, value: "[]" })),
    labelled("Verified benchmark snapshots (optional)", el("textarea", { testid: "allocation-evidence", rows: 3, maxLength: 200000, spellcheck: false, value: "[]" })),
  );
  const result = el("p", { testid: "allocation-result", role: "status" });
  result.style.whiteSpace = "pre-wrap";
  result.style.overflowWrap = "anywhere";
  const pager = el("div");
  pager.append(el("button", { type: "button", testid: "allocation-previous", hidden: true, text: "Previous" }), " ", el("button", { type: "button", testid: "allocation-next", hidden: true, text: "Next" }));
  return [
    el("h3", { text: "Evidence-based allocation preview" }),
    el("p", { testid: "allocation-status", role: "status", text: "Loading evidence availability…" }),
    el("p", { text: "Preview never changes a model. Saved policy stays within the current harness and preserves manual choices. Recording invokes the configured decision model and stores derived task evidence, not transcripts." }),
    labelled("Evidence allocation mode", mode),
    labelled("Recovery allowance, USD", el("input", { testid: "allocation-allowance", type: "number", min: "0", step: "0.01", value: "0" })),
    el("p", { text: "Zero disables paid recovery. Reservations use cost estimates; actual provider charges can exceed an estimate. Unknown costs block further recovery. At most two stronger attempts." }),
    labelled("I accept the held-out evidence limitations and authorize the selected policy and allowance.", el("input", { type: "checkbox", testid: "allocation-accepted" })),
    el("button", { type: "button", testid: "allocation-save", disabled: true, text: "Save allocation policy" }),
    el("p", { testid: "allocation-policy-status", role: "status" }),
    labelled("Task description", el("textarea", { testid: "allocation-task", rows: 3, maxLength: 12000 })),
    el("button", { type: "button", testid: "allocation-assess", text: "Assess with configured decision model" }),
    el("p", { testid: "allocation-assessment", role: "status" }), details,
    labelled("Keep manual baseline selection", el("input", { type: "checkbox", testid: "allocation-pinned", checked: true })),
    el("button", { type: "button", testid: "allocation-compare", text: "Preview recommendation" }), result, pager,
  ];
}

async function allocationPolicyControls(field) {
  const display = result => {
    field("mode").value = result.policy.mode;
    field("allowance").value = result.policy.recoveryAllowance;
    field("accepted").checked = result.policy.acceptedValidation;
    field("candidates").value = JSON.stringify(result.policy.candidates, null, 2);
    field("evidence").value = JSON.stringify(result.policy.evidence, null, 2);
    return `${result.validation.matchedTasks} matched held-out tasks; validation ${result.validation.passed ? "passed" : "not passed"}. ${result.validation.limitation}`;
  };
  field("save").onclick = async () => {
    field("save").disabled = true;
    try {
      const result = await api("/api/routing-configs/allocation/policy", { method: "PUT", body: JSON.stringify({ mode: field("mode").value, candidates: JSON.parse(field("candidates").value), evidence: JSON.parse(field("evidence").value), recoveryAllowance: Number(field("allowance").value), acceptedValidation: field("accepted").checked }) });
      field("policy-status").textContent = `Saved. ${display(result)}`;
    } catch (error) { field("policy-status").textContent = `Not saved: ${error.message}`; }
    finally { field("save").disabled = false; }
  };
  try {
    field("policy-status").textContent = display(await api("/api/routing-configs/allocation/policy"));
    field("mode").disabled = false;
    field("save").disabled = false;
  } catch (error) { field("policy-status").textContent = `Could not load allocation policy: ${error.message}`; }
}

/** Explicit node-local policy controls and a non-mutating preview. No polling or browser storage. */
export async function renderAllocationPreview() {
  if (document.querySelector('[data-testid="allocation-preview"]')) return;
  const section = document.createElement("section");
  section.dataset.testid = "allocation-preview";
  section.className = "routing-config-editor";
  section.append(...allocationFields());
  document.querySelector("#settingsPanel-classifiers").append(section);
  const field = name => section.querySelector(`[data-testid="allocation-${name}"]`);
  await allocationPolicyControls(field);
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
