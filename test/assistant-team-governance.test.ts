import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './assistant-team-fixture.js';
import {
  acceptTeamAssignment,
  assignmentDatabase,
  readTeamWork,
  recoverTeamWork,
  routeTeamAssignment,
} from '../src/assistant-teams/assignments.js';
import { deliverTeamOutbox } from '../src/assistant-teams/delivery.js';
import { decideTeamProposal, listAssistantAttachedSecrets } from '../src/assistant-teams/proposals.js';
import { listTeamAutomations } from '../src/assistant-teams/automations.js';
import { teamAgentReadiness, teamAssignmentDestination } from '../src/assistant-teams/runtime.js';
import { getTeamAssignment, listTeamAgents } from '../src/assistant-teams/store.js';
import { callTeamTool, listTeamTools } from '../src/assistant-teams/tools.js';
import { promptEnded, promptStarted } from '../src/assistant-collaboration/bridge-tools.js';
import { beginPersonalAssistantTurn, finishPersonalAssistantTurn, getPersonalAssistantById, personalAssistantDatabase, savePersonalAssistant } from '../src/personal-assistants.js';
import { saveSecretAccount } from '../src/secrets.js';
import { listWebhookSkills, uploadWebhookSkill } from '../src/webhook-skills.js';
import { clusterV2Database } from '../src/cluster-v2-store.js';
import { listWebhooks } from '../src/webhooks.js';
import { updateGuardianSettings } from '../src/guardian/settings.js';
import { DEFAULT_GUARDIAN_SETTINGS } from '../src/guardian/rules.js';
import { PRODUCTION_RULE } from '../src/guardian/production-rule.js';

async function startLiveRoleTurn(f: Awaited<ReturnType<typeof fixture>>, role: string, text: string) {
  const source = await f.message(text);
  const [assignment] = await acceptTeamAssignment(f.member, source, [role], null);
  await deliverTeamOutbox(f.team.id);
  await routeTeamAssignment(assignment.id, { kind: 'new' });
  const live = (await getTeamAssignment(assignment.id))!;
  const resolved = await teamAssignmentDestination(live);
  await beginPersonalAssistantTurn(f.team.executorAccountId, resolved.profile.id, live.requestId, `${resolved.destination.engine}:${resolved.destination.sessionId}`, text, 'assistant');
  promptStarted(f.team.projectId, resolved.destination.sessionId, live.requestId);
  const identity = {
    account: { accountId: f.member.accountId, username: f.member.username, role: null, homeNodeId: f.member.homeNodeId, isRemoteLogin: false },
    projectId: f.team.projectId,
    conversationId: resolved.destination.sessionId,
    engine: resolved.destination.engine as 'pi',
  };
  return { live, resolved, identity };
}

test('chief can split, add, update, and remove team members with human approval, defaulting new members to Auto mode', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: true, result: { message_id: 7001 } });
  try {
    // Enable Production Guard so we can also verify Auto-mode readiness directly.
    updateGuardianSettings({ ...DEFAULT_GUARDIAN_SETTINGS, enabled: true, rules: [PRODUCTION_RULE] });

    // Attach a secret and a skill to /qa so we can test selective inheritance during split_member.
    const secret = await saveSecretAccount({
      label: 'QA API Key',
      provider: 'custom',
      variables: [{ name: 'QA_TOKEN', kind: 'value', value: 'qa_secret_never_exposed' }],
    });
    const qaMember = (await listTeamAgents(f.team.id)).find(m => m.role === 'qa')!;
    const qaProfile = (await getPersonalAssistantById(qaMember.assistantId))!;
    const { attachOrDetachAssistantSecret } = await import('../src/assistant-teams/proposals.js');
    await attachOrDetachAssistantSecret(qaProfile, secret.id, 'attach');
    await uploadWebhookSkill(await personalAssistantDatabase(), qaProfile.id, [{
      relativePath: 'SKILL.md',
      data: Buffer.from('---\nname: smoke-check\ndescription: Run smoke tests\n---\nRun tests.', 'utf8'),
    }]);

    const { live: bob, resolved: bobRes, identity: bobId } = await startLiveRoleTurn(f, 'bob', 'Split QA into API and E2E specialists');

    // 1. Cannot split and remove the coordinator when keepSource is false.
    const badSplit = await callTeamTool(bobId, 'team_propose_changes', {
      summary: 'Invalid coordinator removal split',
      rationale: 'Should be rejected',
      changes: [{
        kind: 'split_member',
        role: 'bob',
        keepSource: false,
        newMembers: [
          { role: 'lead_a', name: 'Lead A', instructions: 'A' },
          { role: 'lead_b', name: 'Lead B', instructions: 'B' },
        ],
      }],
    });
    assert.equal(badSplit.isError, true);

    // 2. Propose splitting /qa into /qa_api (inherits secret, Auto mode) + /qa_e2e (inherits skill, Auto mode).
    const splitRes = await callTeamTool(bobId, 'team_propose_changes', {
      summary: 'Split /qa into /qa_api and /qa_e2e',
      rationale: 'API tests and browser E2E tests need distinct boundaries.',
      changes: [{
        kind: 'split_member',
        role: 'qa',
        keepSource: false,
        newMembers: [
          { role: 'qa_api', name: 'API QA', instructions: 'Verify REST/GraphQL APIs.', allowBrowser: false, allowTerminal: true, inheritSecrets: true },
          { role: 'qa_e2e', name: 'E2E QA', instructions: 'Verify Playwright UI flows.', allowBrowser: true, allowTerminal: false, inheritSkills: true },
        ],
      }],
    });
    assert.equal(splitRes.isError, undefined, JSON.stringify(splitRes));
    const proposed = JSON.parse((splitRes.content[0] as { text: string }).text);
    assert.equal(proposed.status, 'pending');
    assert.match(proposed.previews[0].headline, /Split \/qa → \/qa_api, \/qa_e2e/);

    // Human approves the split proposal.
    promptEnded(f.team.projectId, bobRes.destination.sessionId, bob.requestId);
    const decided = await decideTeamProposal(f.member, proposed.proposalId, 'approve');
    assert.equal(decided.state, 'applied', JSON.stringify(decided));

    const roster = await listTeamAgents(f.team.id);
    assert.equal(roster.some(m => m.role === 'qa'), false, 'original /qa role removed after split');
    const qaApi = roster.find(m => m.role === 'qa_api')!;
    const qaE2e = roster.find(m => m.role === 'qa_e2e')!;
    assert.ok(qaApi && qaE2e);

    const apiProfile = (await getPersonalAssistantById(qaApi.assistantId))!;
    const e2eProfile = (await getPersonalAssistantById(qaE2e.assistantId))!;
    // Both default to Auto mode (executionSettings === null)!
    assert.equal(apiProfile.executionSettings, null);
    assert.equal(e2eProfile.executionSettings, null);
    assert.equal(apiProfile.allowBrowser, false);
    assert.equal(e2eProfile.allowTerminal, false);

    // Verify selective inheritance of secrets & skills.
    assert.ok((await listAssistantAttachedSecrets(apiProfile)).some(s => s.id === secret.id));
    assert.equal((await listAssistantAttachedSecrets(e2eProfile)).some(s => s.id === secret.id), false);
    assert.ok(listWebhookSkills(await personalAssistantDatabase(), e2eProfile.id).some(s => s.name === 'smoke-check'));
    assert.equal(listWebhookSkills(await personalAssistantDatabase(), apiProfile.id).some(s => s.name === 'smoke-check'), false);

    // Verify Auto mode (executionSettings === null) does NOT fail teamAgentReadiness with "Select a local runtime and model".
    const readiness = await teamAgentReadiness(apiProfile, f.team.projectId);
    assert.equal(readiness.some(p => /Select a local runtime and model/i.test(p)), false, JSON.stringify(readiness));

    // 3. Test keepSource: true split + switching a pinned member back to Auto mode (executionSettings: null).
    await savePersonalAssistant(f.team.executorAccountId, {
      ...apiProfile,
      executionSettings: { harnessId: 'pi', provider: 'openai', modelId: 'gpt-4o', reasoning: 'low' },
    }, apiProfile.id);

    const { live: bob2, resolved: bob2Res, identity: bob2Id } = await startLiveRoleTurn(f, 'bob', 'Spin off perf specialist and switch qa_api to Auto');
    const spinOff = await callTeamTool(bob2Id, 'team_propose_changes', {
      summary: 'Spin off /perf from /qa_api and switch /qa_api to Auto mode',
      rationale: 'Keep /qa_api focused and let Bob Auto pick models.',
      changes: [{
        kind: 'split_member',
        role: 'qa_api',
        keepSource: true,
        sourceUpdates: { instructions: 'Focus strictly on contract tests.', executionSettings: null },
        newMembers: [{ role: 'perf', name: 'Performance QA', instructions: 'Run k6 load tests.' }],
      }],
    });
    assert.equal(spinOff.isError, undefined, JSON.stringify(spinOff));
    const spinData = JSON.parse((spinOff.content[0] as { text: string }).text);
    promptEnded(f.team.projectId, bob2Res.destination.sessionId, bob2.requestId);
    const appliedSpin = await decideTeamProposal(f.member, spinData.proposalId, 'approve');
    assert.equal(appliedSpin.state, 'applied', JSON.stringify(appliedSpin));

    const updatedApi = (await getPersonalAssistantById(qaApi.assistantId))!;
    assert.equal(updatedApi.instructions, 'Focus strictly on contract tests.');
    assert.equal(updatedApi.executionSettings, null, 'switched back to Auto mode');
    assert.ok((await listTeamAgents(f.team.id)).some(m => m.role === 'perf'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('specialist agents can propose automations & scheduled tasks, requiring Chief approval to go live', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: true, result: { message_id: 7101 } });
  try {
    // 1. Start a live specialist (/qa) turn.
    const { live: qa, resolved: qaRes, identity: qaId } = await startLiveRoleTurn(f, 'qa', '/qa set up nightly regression and PR webhook');

    // Specialist sees automation proposal tools, NOT coordinator-only decide/propose_changes tools.
    const qaTools = (await listTeamTools(qaId)).map(t => t.name);
    assert.ok(qaTools.includes('team_list_automations'));
    assert.ok(qaTools.includes('team_propose_automation'));
    assert.equal(qaTools.includes('team_decide_automation'), false);
    assert.equal(qaTools.includes('team_propose_changes'), false);

    // 2. Specialist proposes a nightly scheduled task and a webhook automation.
    const schedRes = await callTeamTool(qaId, 'team_propose_automation', {
      name: 'Nightly AI-DLC Regression Suite',
      trigger: 'schedule',
      instructions: 'Run the full test suite and post failures to Chief.',
      schedule: { frequency: 'daily', hour: 2, minute: 0, weekday: 1, timezone: 'UTC' },
      rationale: 'Catch regressions overnight before standup.',
    });
    assert.equal(schedRes.isError, undefined, JSON.stringify(schedRes));
    const schedReq = JSON.parse((schedRes.content[0] as { text: string }).text);
    assert.equal(schedReq.status, 'pending_chief');

    const hookRes = await callTeamTool(qaId, 'team_propose_automation', {
      name: 'GitHub PR Opened QA Hook',
      trigger: 'webhook',
      instructions: 'Run security and contract checks on new PRs.',
      rationale: 'Automate PR verification.',
    });
    assert.equal(hookRes.isError, undefined, JSON.stringify(hookRes));
    const hookReq = JSON.parse((hookRes.content[0] as { text: string }).text);
    assert.equal(hookReq.status, 'pending_chief');

    // Neither automation exists live in webhooks yet before Chief approval!
    const db = await clusterV2Database();
    assert.equal(listWebhooks(db).filter(w => w.name === 'Nightly AI-DLC Regression Suite' || w.name === 'GitHub PR Opened QA Hook').length, 0);

    // Specialist cannot approve its own request.
    const selfApprove = await callTeamTool(qaId, 'team_decide_automation', { requestId: schedReq.requestId, decision: 'approve' });
    assert.equal(selfApprove.isError, true);

    // 3. Finish specialist's direct turn -> Chief review automatically includes the pending automation requests!
    promptEnded(f.team.projectId, qaRes.destination.sessionId, qa.requestId);
    await finishPersonalAssistantTurn(f.team.executorAccountId, qaRes.profile.id, qa.requestId, 'Proposed nightly schedule and PR webhook.');
    f.db.prepare('UPDATE assistant_team_work SET phase=? WHERE assignment_id=?').run('dispatched', qa.id);
    await recoverTeamWork(f.team.id);

    const assignDb = await assignmentDatabase();
    const allAssignments = (assignDb.prepare('SELECT record FROM assistant_team_assignments WHERE team_id=?').all(f.team.id) as Array<{ record: string }>)
      .map(r => JSON.parse(r.record));
    const chiefReview = allAssignments.find(a => a.rootId === qa.rootId && a.role === 'bob');
    assert.ok(chiefReview, 'Chief review assignment queued');
    const reviewWork = (await readTeamWork(f.team.id)).find(w => w.assignmentId === chiefReview.id)!;
    assert.match(reviewWork.message, new RegExp(schedReq.requestId));
    assert.match(reviewWork.message, new RegExp(hookReq.requestId));

    // 4. Chief reviews & approves the nightly schedule, rejects the webhook.
    const chiefDest = await teamAssignmentDestination(chiefReview);
    await beginPersonalAssistantTurn(f.team.executorAccountId, chiefDest.profile.id, chiefReview.requestId, `${chiefDest.destination.engine}:${chiefDest.destination.sessionId}`, 'review', 'assistant');
    promptStarted(f.team.projectId, chiefDest.destination.sessionId, chiefReview.requestId);
    const chiefId = {
      account: { accountId: f.member.accountId, username: f.member.username, role: null, homeNodeId: f.member.homeNodeId, isRemoteLogin: false },
      projectId: f.team.projectId,
      conversationId: chiefDest.destination.sessionId,
      engine: chiefDest.destination.engine as 'pi',
    };

    const approveRes = await callTeamTool(chiefId, 'team_decide_automation', {
      requestId: schedReq.requestId,
      decision: 'approve',
      note: 'Good cadence for overnight checks.',
    });
    assert.equal(approveRes.isError, undefined, JSON.stringify(approveRes));
    const approved = JSON.parse((approveRes.content[0] as { text: string }).text);
    assert.equal(approved.status, 'approved');
    assert.ok(approved.automationId);

    const rejectRes = await callTeamTool(chiefId, 'team_decide_automation', {
      requestId: hookReq.requestId,
      decision: 'reject',
      note: 'Already handled by GitHub Actions.',
    });
    assert.equal(rejectRes.isError, undefined, JSON.stringify(rejectRes));
    const rejected = JSON.parse((rejectRes.content[0] as { text: string }).text);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.automationId, null);

    // Verify live scheduled task exists in webhooks table targeting /qa in Auto mode, and rejected webhook does NOT!
    const liveHooks = listWebhooks(db);
    const createdSchedule = liveHooks.find(w => w.id === approved.automationId);
    assert.ok(createdSchedule);
    assert.equal(createdSchedule.trigger, 'schedule');
    assert.equal(createdSchedule.name, 'Nightly AI-DLC Regression Suite');
    assert.equal(createdSchedule.model, null, 'uses Auto mode by default');
    assert.ok(createdSchedule.nextRun && createdSchedule.nextRun > Date.now());
    assert.equal(liveHooks.some(w => w.name === 'GitHub PR Opened QA Hook'), false);

    // Verify team_list_automations surfaces the live schedule and request history.
    const listed = await listTeamAutomations(f.team.id);
    assert.ok(listed.automations.some(a => a.id === approved.automationId && a.targetRole === 'qa'));
    assert.equal(listed.requests.find(r => r.id === schedReq.requestId)?.state, 'approved');
    assert.equal(listed.requests.find(r => r.id === hookReq.requestId)?.state, 'rejected');

    // 5. Chief itself proposing an automation approves and activates it immediately.
    const chiefDirect = await callTeamTool(chiefId, 'team_propose_automation', {
      name: 'Weekly AI-DLC Velocity Digest',
      trigger: 'schedule',
      targetRole: 'bob',
      instructions: 'Summarize completed units and open blockers.',
      schedule: { frequency: 'weekly', hour: 9, minute: 0, weekday: 1, timezone: 'UTC' },
      rationale: 'Monday standup briefing.',
    });
    assert.equal(chiefDirect.isError, undefined, JSON.stringify(chiefDirect));
    const directData = JSON.parse((chiefDirect.content[0] as { text: string }).text);
    assert.equal(directData.status, 'approved');
    assert.ok(directData.automationId);
    promptEnded(f.team.projectId, chiefDest.destination.sessionId, chiefReview.requestId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
