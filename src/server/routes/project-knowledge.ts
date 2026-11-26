import { z } from "zod";
import {
  KnowledgeError, addRule, deleteProposal, forgetRule, listProposals, normalizedRuleText, projectShelf, readNotes, readProposal, readSubject, readSubjects, readSubjectsIn, removeRule, writeNote,
} from "../../project-knowledge.js";
import { generalShelf, installedGeneralSubjects } from "../../general-knowledge.js";
import { jointBobSourceProject } from "../conversation-closeout.js";
import { getProject, projectVisible } from "../../store.js";
import type { ProjectRecord } from "../../types.js";
import { sendError } from "../http-auth.js";
import { assertProjectEditable } from "../projects.js";
import { app } from "../state.js";

const acceptSchema = z.object({
  subject: z.string().trim().min(1).max(60).optional(),
  text: z.string().trim().min(1).max(600).optional(),
}).strict();

async function visibleProject(projectId: string): Promise<ProjectRecord> {
  const project = await getProject(projectId);
  if (!project || !await projectVisible(project.id)) throw new KnowledgeError(404, "Project not found");
  return project;
}

const removeSchema = z.object({
  scope: z.enum(["project", "general"]),
  subject: z.string().trim().min(1).max(60),
  ruleId: z.string().trim().min(1).max(60),
}).strict();

/**
 * The project's rules, its pending proposals, and Joint Bob's general rules: the editable copy in this machine's
 * Joint Bob source when it has one, otherwise the copy that shipped (which cannot be changed here).
 */
async function knowledgeView(root: string) {
  const source = await jointBobSourceProject();
  return {
    subjects: readSubjects(root), proposals: listProposals(root),
    general: source ? readSubjectsIn(generalShelf(source.path).directory) : installedGeneralSubjects(),
    generalRemovable: source !== null,
  };
}

function sendKnowledgeError(response: Parameters<typeof sendError>[0], error: unknown): boolean {
  if (error instanceof KnowledgeError) { sendError(response, error.status, error.message); return true; }
  if (error instanceof z.ZodError) { sendError(response, 400, error.message); return true; }
  return false;
}

/** The project's rules by subject and the rule proposals waiting for a person. */
app.get("/api/projects/:projectId/knowledge", async (request, response, next) => {
  try {
    response.json(await knowledgeView((await visibleProject(request.params.projectId)).path));
  } catch (error) { if (!sendKnowledgeError(response, error)) next(error); }
});

/** Anyone who can edit the project may accept: an add writes the rule, a remove or merge deletes the rule it names. */
app.post("/api/projects/:projectId/knowledge/proposals/:id/accept", async (request, response, next) => {
  try {
    const edits = acceptSchema.parse(request.body ?? {});
    const project = await visibleProject(request.params.projectId);
    await assertProjectEditable(project);
    const proposal = readProposal(project.path, request.params.id);
    if (!proposal) throw new KnowledgeError(404, "Proposal not found");
    if (proposal.action === "add") {
      addRule(project.path, { subject: edits.subject ?? proposal.subject, text: edits.text ?? proposal.text, evidence: proposal.evidence });
    } else {
      const current = proposal.ruleId ? readSubject(project.path, proposal.subject)?.rules.find((rule) => rule.id === proposal.ruleId) : undefined;
      if (!current) throw new KnowledgeError(409, "The rule this proposal names no longer exists");
      if (normalizedRuleText(current.text) !== normalizedRuleText(proposal.text)) throw new KnowledgeError(409, "The rule changed since this was suggested");
      if (proposal.action === "merge" && !(proposal.mergeWith && readSubjects(project.path).some((subject) => subject.rules.some((rule) => rule.id === proposal.mergeWith)))) {
        throw new KnowledgeError(409, "The rule this one merges into no longer exists");
      }
      removeRule(project.path, proposal.subject, proposal.ruleId!);
    }
    deleteProposal(project.path, proposal.id);
    response.json(await knowledgeView(project.path));
  } catch (error) { if (!sendKnowledgeError(response, error)) next(error); }
});

/** Drops the proposal and remembers it in the source conversation's note, so the same rule is not proposed again. */
app.post("/api/projects/:projectId/knowledge/proposals/:id/dismiss", async (request, response, next) => {
  try {
    const project = await visibleProject(request.params.projectId);
    await assertProjectEditable(project);
    const proposal = readProposal(project.path, request.params.id);
    if (!proposal) throw new KnowledgeError(404, "Proposal not found");
    const note = readNotes(project.path).find((candidate) => candidate.conversationId === proposal.source);
    if (note && proposal.action === "add") writeNote(project.path, { ...note, dismissed: [...new Set([...note.dismissed, normalizedRuleText(proposal.text)])] });
    deleteProposal(project.path, proposal.id);
    response.json(await knowledgeView(project.path));
  } catch (error) { if (!sendKnowledgeError(response, error)) next(error); }
});

/** Removes a learned rule, so a person can undo what learning installed. A removed rule is not learned again. */
app.post("/api/projects/:projectId/knowledge/rules/remove", async (request, response, next) => {
  try {
    const target = removeSchema.parse(request.body ?? {});
    const project = await visibleProject(request.params.projectId);
    await assertProjectEditable(project);
    let removed: boolean;
    if (target.scope === "project") removed = forgetRule(projectShelf(project.path), target.subject, target.ruleId);
    else {
      const source = await jointBobSourceProject();
      if (!source) throw new KnowledgeError(409, "This machine has no Joint Bob source; remove general rules on a machine that has it");
      await assertProjectEditable(source);
      removed = forgetRule(generalShelf(source.path), target.subject, target.ruleId);
    }
    if (!removed) throw new KnowledgeError(404, "Rule not found");
    response.json(await knowledgeView(project.path));
  } catch (error) { if (!sendKnowledgeError(response, error)) next(error); }
});
