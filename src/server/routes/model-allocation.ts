import { z } from "zod";
import { actingAccount } from "../../account-context.js";
import { decisionModelTarget } from "../../classifiers/conversation-routing.js";
import { allocationInputSchema, ALLOCATION_POLICY_VERSION, recommendModels } from "../../model-allocation.js";
import { AllocationStore } from "../../model-allocation-store.js";
import { routingPolicyDatabase } from "../../routing-policy.js";
import { listProjects } from "../../store.js";
import { systemDecisionKey } from "../../system-ai.js";
import { systemAiSettings } from "../../system-ai-config.js";
import { assessTask, taskAssessmentInputSchema } from "../../task-assessment.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const previewSchema = allocationInputSchema.omit({ outcomes: true, authorizedProjectIds: true, now: true }).strict();
let evidenceStore: AllocationStore | undefined;
function store(): AllocationStore { return evidenceStore ??= new AllocationStore(routingPolicyDatabase()); }

app.get("/api/routing-configs/allocation", async (_request, response, next) => {
  try {
    const account = actingAccount();
    if (!account) { sendError(response, 401, "An account is required"); return; }
    const projects = await listProjects();
    response.json({ mode: "recommendation-only", version: ALLOCATION_POLICY_VERSION, automaticEnabled: false,
      observations: store().outcomes(account.accountId, projects.map(project => project.id)).length,
      explanation: "No model is switched by previews. Automatic recovery requires held-out acceptance, a finite approved allowance, and a stopped writer. Legacy outcomes without exact model identity and verified checks are not counted.",
      sources: [{ url: "https://www.swebench.com/", benchmark: "SWE-bench Verified", version: "500", inspectedAt: "2026-11-12", limitation: "Published mini-SWE-agent results are not interchangeable with Pi, Claude or Kiro. No scores were imported without exact release/configuration mapping." }] });
  } catch (error) { next(error); }
});

app.post("/api/routing-configs/allocation/preview", async (request, response, next) => {
  try {
    const account = actingAccount();
    if (!account) { sendError(response, 401, "An account is required"); return; }
    const input = previewSchema.parse(request.body);
    const projectIds = (await listProjects()).map(project => project.id);
    response.json({ ...recommendModels({ ...input, outcomes: store().outcomes(account.accountId, projectIds), authorizedProjectIds: projectIds, now: new Date().toISOString() }),
      notice: "Preview uses your supplied candidate cost/capability assumptions. It grants no credential access and changes no running model." });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid allocation preview; history and project access are resolved server-side"); return; }
    next(error);
  }
});

app.post("/api/routing-configs/allocation/assess", async (request, response, next) => {
  try {
    if (!actingAccount()) { sendError(response, 401, "An account is required"); return; }
    const input = taskAssessmentInputSchema.parse(request.body);
    const classifier = systemAiSettings().decision.model;
    let target;
    try { target = await decisionModelTarget(classifier, systemDecisionKey(classifier)); }
    catch { sendError(response, 503, "Task assessment unavailable; configure the node's decision model"); return; }
    if (!target) { sendError(response, 503, "Task assessment unavailable; keep the approved baseline"); return; }
    response.json({ assessment: await assessTask(input, target.target, target.apiKey) });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid bounded task description"); return; }
    next(error);
  }
});
