import { api } from "./api.js";

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
  section.innerHTML = `<h3>Evidence-based allocation preview</h3>
    <p data-testid="allocation-status" role="status">Loading evidence availability…</p>
    <p>Preview never changes a model. Saved policy stays within the current harness and preserves manual choices. Recording invokes the configured decision model and stores derived task evidence, not transcripts.</p>
    <label>Evidence allocation mode<select data-testid="allocation-mode" disabled><option value="off">Off</option><option value="recommendation">Record recommendations</option><option value="automatic">Automatic after validation</option></select></label>
    <label>Recovery allowance, USD<input data-testid="allocation-allowance" type="number" min="0" step="0.01" value="0" /></label>
    <p>Zero disables paid recovery. Reservations use cost estimates; actual provider charges can exceed an estimate. Unknown costs block further recovery. At most two stronger attempts.</p>
    <label><input type="checkbox" data-testid="allocation-accepted" /> I accept the held-out evidence limitations and authorize the selected policy and allowance.</label>
    <button type="button" data-testid="allocation-save" disabled>Save allocation policy</button>
    <p data-testid="allocation-policy-status" role="status"></p>
    <label>Task description<textarea data-testid="allocation-task" rows="3" maxlength="12000"></textarea></label>
    <button type="button" data-testid="allocation-assess">Assess with configured decision model</button>
    <p data-testid="allocation-assessment" role="status"></p>
    <details><summary>Candidate estimates and benchmark snapshots</summary>
      <p>Advanced preview: enter a JSON array of candidates with exact identity, capabilities and cost estimates. The first candidate is the baseline. Unknown costs must be null, not zero. Include no credentials. History is loaded only from your accessible projects on this machine.</p>
      <label>Candidate estimates<textarea data-testid="allocation-candidates" rows="6" maxlength="100000" spellcheck="false">[]</textarea></label>
      <label>Verified benchmark snapshots (optional)<textarea data-testid="allocation-evidence" rows="3" maxlength="200000" spellcheck="false">[]</textarea></label>
    </details>
    <label><input type="checkbox" data-testid="allocation-pinned" checked /> Keep manual baseline selection</label>
    <button type="button" data-testid="allocation-compare">Preview recommendation</button>
    <p data-testid="allocation-result" role="status" style="white-space:pre-wrap;overflow-wrap:anywhere"></p>
    <div><button type="button" data-testid="allocation-previous" hidden>Previous</button> <button type="button" data-testid="allocation-next" hidden>Next</button></div>`;
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
