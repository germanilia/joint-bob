import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './assistant-team-fixture.js';
import {
  acceptTeamAssignment,
  assignmentDatabase,
  consumeTeamCallback,
  consumeTeamConfirmation,
  readTeamWork,
  recoverTeamWork,
  routeTeamAssignment,
} from '../src/assistant-teams/assignments.js';
import { deliverTeamOutbox, listTeamOutbox } from '../src/assistant-teams/delivery.js';
import {
  createTeamProposal,
  decideTeamProposal,
  getTeamProposal,
  listAssistantAttachedSecrets,
  listNodeAttachableSecrets,
  listTeamProposals,
} from '../src/assistant-teams/proposals.js';
import { teamAssignmentDestination } from '../src/assistant-teams/runtime.js';
import { getTeam, getTeamAssignment, listTeamAgents, saveTeamMembers } from '../src/assistant-teams/store.js';
import { callTeamTool, listTeamTools } from '../src/assistant-teams/tools.js';
import { promptEnded, promptStarted } from '../src/assistant-collaboration/bridge-tools.js';
import { createLocalUser } from '../src/auth.js';
import { addClusterLocalMember } from '../src/cluster-accounts.js';
import { beginPersonalAssistantTurn, finishPersonalAssistantTurn, getPersonalAssistantById, personalAssistantDatabase } from '../src/personal-assistants.js';
import { conversationScopeId, getScopeSecretAccounts, saveSecretAccount } from '../src/secrets.js';
import { listWebhookSkills } from '../src/webhook-skills.js';

test('coordinator inspects node secrets metadata (never values), proposes bundled live changes, and resumes on approval', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const sends: any[] = [];
  globalThis.fetch = async (_url, init) => {
    sends.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: 5000 + sends.length } });
  };
  try {
    // Seed a GitHub secret on the host node.
    const ghSecret = await saveSecretAccount({
      label: 'Host GitHub Token',
      provider: 'github',
      variables: [{ name: 'GH_TOKEN', kind: 'value', value: 'ghp_super_secret_value_never_exposed' }],
    });

    // Accept and start a live coordinator (bob) turn.
    const source = await f.message('Check CI status on GitHub');
    const [bobAssignment] = await acceptTeamAssignment(f.member, source, ['bob'], null);
    await deliverTeamOutbox(f.team.id);
    await routeTeamAssignment(bobAssignment.id, { kind: 'new' });
    const liveBob = (await getTeamAssignment(bobAssignment.id))!;
    const resolvedBob = await teamAssignmentDestination(liveBob);
    await beginPersonalAssistantTurn(f.team.executorAccountId, resolvedBob.profile.id, liveBob.requestId, `pi:${resolvedBob.destination.sessionId}`, 'fixture', 'assistant');
    promptStarted(f.team.projectId, resolvedBob.destination.sessionId, liveBob.requestId);

    const bobIdentity = {
      account: { accountId: f.member.accountId, username: f.member.username, role: null, homeNodeId: f.member.homeNodeId, isRemoteLogin: false },
      projectId: f.team.projectId,
      conversationId: resolvedBob.destination.sessionId,
      engine: 'pi' as const,
    };

    // 1. Coordinator sees all new inspection & proposal tools.
    const toolNames = (await listTeamTools(bobIdentity)).map(t => t.name);
    assert.ok(toolNames.includes('team_list_agents'));
    assert.ok(toolNames.includes('team_inspect_agent'));
    assert.ok(toolNames.includes('team_node_catalog'));
    assert.ok(toolNames.includes('team_propose_changes'));

    // 2. team_node_catalog exposes secret metadata, NEVER the secret value.
    const catalogRes = await callTeamTool(bobIdentity, 'team_node_catalog', {});
    assert.equal(catalogRes.isError, undefined);
    const catalogText = (catalogRes.content[0] as { text: string }).text;
    assert.doesNotMatch(catalogText, /ghp_super_secret_value_never_exposed/, 'secret values must never be exposed');
    const catalog = JSON.parse(catalogText);
    assert.ok(catalog.secrets.some((s: any) => s.id === ghSecret.id && s.label === 'Host GitHub Token' && s.provider === 'github'));

    // 3. team_list_agents and team_inspect_agent expose rich member details & usage.
    const agentsRes = await callTeamTool(bobIdentity, 'team_list_agents', {});
    const agents = JSON.parse((agentsRes.content[0] as { text: string }).text);
    const qaSummary = agents.find((a: any) => a.role === 'qa');
    assert.ok(qaSummary);
    assert.equal(typeof qaSummary.allowTerminal, 'boolean');
    assert.equal(typeof qaSummary.usage.assignmentCount, 'number');

    const inspectRes = await callTeamTool(bobIdentity, 'team_inspect_agent', { role: 'qa' });
    const qaDetail = JSON.parse((inspectRes.content[0] as { text: string }).text);
    assert.equal(qaDetail.role, 'qa');
    assert.ok(Array.isArray(qaDetail.attachedSecrets));

    // 4. Propose a bundled change: attach gh secret to qa, enable terminal + update instructions on qa, install a skill on qa, and remove unused support from the team.
    const qaMember = (await listTeamAgents(f.team.id)).find(m => m.role === 'qa')!;
    const supportMember = (await listTeamAgents(f.team.id)).find(m => m.role === 'support')!;
    const proposeRes = await callTeamTool(bobIdentity, 'team_propose_changes', {
      summary: 'Equip qa with GitHub secret, terminal, CI skill, and remove unused support',
      rationale: 'qa needs GitHub CLI access to check live CI pipelines; support is unused.',
      changes: [
        { kind: 'attach_secret', role: 'qa', secretAccountId: ghSecret.id },
        { kind: 'update_assistant', role: 'qa', allowTerminal: true, instructions: 'Always verify live CI with gh run list.' },
        {
          kind: 'upsert_skill',
          role: 'qa',
          files: [{ relativePath: 'SKILL.md', content: '---\nname: ci-check\ndescription: Check GitHub Actions CI runs\n---\nRun `gh run list --limit 5`.' }],
        },
        { kind: 'remove_member', role: 'support' },
      ],
    });
    assert.equal(proposeRes.isError, undefined);
    const proposed = JSON.parse((proposeRes.content[0] as { text: string }).text);
    assert.equal(proposed.status, 'pending');
    const proposalId = proposed.proposalId as string;

    // Finish Bob's turn while proposal is pending -> Bob must pause in waiting_for_human, NOT publish.
    promptEnded(f.team.projectId, resolvedBob.destination.sessionId, liveBob.requestId);
    await finishPersonalAssistantTurn(f.team.executorAccountId, resolvedBob.profile.id, liveBob.requestId, 'Waiting for approval.');
    f.db.prepare('UPDATE assistant_team_work SET phase=? WHERE assignment_id=?').run('dispatched', liveBob.id);
    await recoverTeamWork(f.team.id);

    const pausedBob = (await getTeamAssignment(liveBob.id))!;
    assert.equal(pausedBob.state, 'waiting_for_human');
    const pausedWork = (await readTeamWork(f.team.id)).find(w => w.assignmentId === liveBob.id)!;
    assert.equal(pausedWork.reason, 'awaiting_proposal_approval');

    // Verify Telegram proposal message has Approve / Reject buttons (<= 64 bytes callback_data).
    const proposalOutbox = (await listTeamOutbox(f.team.id)).find(row => row.id === `${proposalId}:proposal:0`)!;
    assert.ok(proposalOutbox && proposalOutbox.state === 'sent');
    const proposalSend = sends.find(s => s.reply_markup?.inline_keyboard?.[0]?.[0]?.text === 'Approve');
    assert.ok(proposalSend);
    const [approveBtn, rejectBtn] = proposalSend.reply_markup.inline_keyboard[0];
    assert.equal(approveBtn.text, 'Approve');
    assert.equal(rejectBtn.text, 'Reject');
    assert.ok(Buffer.byteLength(approveBtn.callback_data) <= 64);

    // Outsider callback must be rejected.
    await assert.rejects(consumeTeamCallback(f.team.id, {
      data: approveBtn.callback_data,
      from: { id: 999999 },
      message: { message_id: proposalOutbox.receiptId, chat: { id: -1, type: 'supergroup' } },
    }));

    // 5. Another enrolled team member can approve via Telegram button.
    const secondUser = createLocalUser({ username: 'teammate2', email: 't2@example.test' }).user;
    addClusterLocalMember(f.db, f.team.clusterId, secondUser.accountId);
    f.db.prepare('INSERT INTO assistant_team_telegram_members VALUES(?,?,?,?)').run(f.team.id, secondUser.accountId, '77', 'Teammate 2');

    await consumeTeamCallback(f.team.id, {
      data: approveBtn.callback_data,
      from: { id: 77 },
      message: { message_id: proposalOutbox.receiptId, chat: { id: -1, type: 'supergroup' } },
    });

    // Verify proposal applied live immediately!
    const settled = (await getTeamProposal(proposalId))!;
    assert.equal(settled.state, 'applied');
    assert.equal(settled.decidedBy, secondUser.accountId);
    assert.ok((settled.appliedSummary?.length ?? 0) === 4);

    const updatedQa = (await getPersonalAssistantById(qaMember.assistantId))!;
    assert.equal(updatedQa.allowTerminal, true);
    assert.equal(updatedQa.instructions, 'Always verify live CI with gh run list.');
    const qaSecrets = await listAssistantAttachedSecrets(updatedQa);
    assert.ok(qaSecrets.some(s => s.id === ghSecret.id));
    const qaSkills = listWebhookSkills(await personalAssistantDatabase(), updatedQa.id);
    assert.ok(qaSkills.some(s => s.name === 'ci-check'));

    // Support was removed from team, while its underlying PersonalAssistant record still exists.
    assert.equal((await listTeamAgents(f.team.id)).some(m => m.role === 'support'), false);
    assert.ok(await getPersonalAssistantById(supportMember.assistantId));

    // Coordinator assignment was automatically resumed and queued to continue the task!
    const resumedBob = (await getTeamAssignment(liveBob.id))!;
    assert.equal(resumedBob.state, 'queued');
    const resumedWork = (await readTeamWork(f.team.id)).find(w => w.assignmentId === liveBob.id)!;
    assert.match(resumedWork.message, /APPROVED and applied live immediately/);

    // Verify team conversation for qa automatically inherits the attached secret on destination resolution!
    const [qaDirect] = await acceptTeamAssignment(f.member, await f.message('/qa check ci now'), ['qa'], null);
    await routeTeamAssignment(qaDirect.id, { kind: 'new' });
    const qaDest = await teamAssignmentDestination((await getTeamAssignment(qaDirect.id))!);
    const qaConvSecrets = await getScopeSecretAccounts('conversation', conversationScopeId(qaDest.destination.engine, qaDest.destination.sessionId));
    assert.ok(qaConvSecrets.accountIds.includes(ghSecret.id), 'team conversation inherits assistant attached secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('direct specialist work triggers immediate coordinator review for any coordinator role, and rejection resumes cleanly', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const sends: any[] = [];
  globalThis.fetch = async (_url, init) => {
    sends.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: 6000 + sends.length } });
  };
  try {
    // Rename coordinator from 'bob' to 'lead' to verify no hardcoded 'bob' dependency.
    const team = await getTeam(f.team.id);
    const currentAgents = await listTeamAgents(f.team.id);
    await saveTeamMembers(
      f.team.id,
      currentAgents.map(a => ({ role: a.role === 'bob' ? 'lead' : a.role, assistantId: a.assistantId })),
      'lead',
      team.revision,
    );

    // Human calls /qa directly.
    const source = await f.message('/qa inspect the release');
    const [qaAssignment] = await acceptTeamAssignment(f.member, source, ['qa'], null);
    await deliverTeamOutbox(f.team.id);
    await routeTeamAssignment(qaAssignment.id, { kind: 'new' });
    const qaLive = (await getTeamAssignment(qaAssignment.id))!;
    const qaDest = await teamAssignmentDestination(qaLive);
    await beginPersonalAssistantTurn(f.team.executorAccountId, qaDest.profile.id, qaLive.requestId, `pi:${qaDest.destination.sessionId}`, 'direct qa', 'assistant');
    await finishPersonalAssistantTurn(f.team.executorAccountId, qaDest.profile.id, qaLive.requestId, 'QA draft answer');
    f.db.prepare('UPDATE assistant_team_work SET phase=? WHERE assignment_id=?').run('dispatched', qaLive.id);

    // Recover: qa completes, raw QA draft is NOT published directly; instead 'lead' review assignment is queued!
    await recoverTeamWork(f.team.id);
    assert.equal(sends.filter(s => String(s.text).includes('QA draft answer')).length, 0, 'raw direct specialist answer waits for coordinator review');

    const db = await assignmentDatabase();
    const all = (db.prepare('SELECT record FROM assistant_team_assignments WHERE team_id=?').all(f.team.id) as Array<{ record: string }>)
      .map(r => JSON.parse(r.record));
    const review = all.find(a => a.rootId === qaLive.rootId && a.role === 'lead');
    assert.ok(review, 'coordinator review assignment created for custom coordinator role "lead"');
    const reviewWork = (await readTeamWork(f.team.id)).find(w => w.assignmentId === review.id)!;
    assert.match(reviewWork.message, /QA draft answer/);

    // Verify proposal rejection via reply works and resumes 'lead'.
    const leadDest = await teamAssignmentDestination(review);
    await beginPersonalAssistantTurn(f.team.executorAccountId, leadDest.profile.id, review.requestId, `pi:${leadDest.destination.sessionId}`, 'review', 'assistant');
    promptStarted(f.team.projectId, leadDest.destination.sessionId, review.requestId);
    const initialAllowBrowser = qaDest.profile.allowBrowser;
    const proposal = await createTeamProposal(review.id, {
      summary: 'Toggle browser on qa',
      rationale: 'Not needed',
      changes: [{ kind: 'update_assistant', role: 'qa', allowBrowser: !initialAllowBrowser }],
    });
    promptEnded(f.team.projectId, leadDest.destination.sessionId, review.requestId);
    const sentProposal = (await listTeamOutbox(f.team.id)).find(r => r.id === `${proposal.id}:proposal:0`)!;
    assert.equal(sentProposal.state, 'sent');

    // Reply "reject" to the proposal message.
    const reply = await f.message('reject', { reply_to_message: { message_id: sentProposal.receiptId } });
    assert.equal(await consumeTeamConfirmation(reply), true);
    assert.equal((await getTeamProposal(proposal.id))!.state, 'rejected');
    const qaProfile = (await getPersonalAssistantById(qaDest.profile.id))!;
    assert.equal(qaProfile.allowBrowser, initialAllowBrowser, 'rejected proposal does not mutate assistant');
    const listed = await listTeamProposals(f.team.id);
    assert.equal(listed.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('coordinator sees pending proposals in execution evidence, lists/supersedes them, and detects unusable cross-node secrets', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let seq = 7000;
  globalThis.fetch = async () => Response.json({ ok: true, result: { message_id: ++seq } });
  try {
    // Seed a foreign-origin secret on this node without any grant/scope for this team project.
    const blockedSecret = await saveSecretAccount({
      label: 'Blocked Shared GitHub',
      provider: 'github',
      replicate: false,
      variables: [{ name: 'GH_TOKEN', kind: 'value', value: 'ghp_blocked_secret_never_exposed' }],
    });
    f.db.prepare('UPDATE secret_accounts SET origin_node_id = ? WHERE id = ?').run(randomUUID(), blockedSecret.id);

    const source = await f.message('Add a developer agent');
    const [bobAssignment] = await acceptTeamAssignment(f.member, source, ['bob'], null);
    await deliverTeamOutbox(f.team.id);
    await routeTeamAssignment(bobAssignment.id, { kind: 'new' });
    const liveBob = (await getTeamAssignment(bobAssignment.id))!;
    const resolvedBob = await teamAssignmentDestination(liveBob);
    await beginPersonalAssistantTurn(f.team.executorAccountId, resolvedBob.profile.id, liveBob.requestId, `pi:${resolvedBob.destination.sessionId}`, 'fixture', 'assistant');
    promptStarted(f.team.projectId, resolvedBob.destination.sessionId, liveBob.requestId);
    const bobIdentity = {
      account: { accountId: f.member.accountId, username: f.member.username, role: null, homeNodeId: f.member.homeNodeId, isRemoteLogin: false },
      projectId: f.team.projectId,
      conversationId: resolvedBob.destination.sessionId,
      engine: 'pi' as const,
    };

    // 1. team_node_catalog separates unusableSecrets from usable secrets and explains why.
    const catalogRes = await callTeamTool(bobIdentity, 'team_node_catalog', {});
    assert.equal(catalogRes.isError, undefined);
    const catalog = JSON.parse((catalogRes.content[0] as { text: string }).text);
    assert.equal(catalog.secrets.some((s: any) => s.id === blockedSecret.id), false, 'blocked foreign secret must not be advertised as usable');
    const unusable = catalog.unusableSecrets.find((s: any) => s.id === blockedSecret.id);
    assert.ok(unusable, 'blocked foreign secret is surfaced in unusableSecrets');
    assert.match(unusable.reason, /Settings → Secrets/);

    // 2. Attempting to attach the unusable secret returns a clear actionable error.
    const badAttach = await callTeamTool(bobIdentity, 'team_propose_changes', {
      summary: 'Attach blocked secret',
      rationale: 'Test guard',
      changes: [{ kind: 'attach_secret', role: 'bob', secretAccountId: blockedSecret.id }],
    });
    assert.equal(badAttach.isError, true);
    assert.match((badAttach.content[0] as { text: string }).text, /Settings → Secrets/);

    // 3. Create a pending proposal, then check team_list_proposals and teamExecutionEvidence.
    const firstRes = await callTeamTool(bobIdentity, 'team_propose_changes', {
      summary: 'Create /developer v1',
      rationale: 'Initial proposal',
      changes: [{ kind: 'create_member', role: 'developer', name: 'Developer v1', instructions: 'Initial instructions' }],
    });
    assert.equal(firstRes.isError, undefined);
    const firstProposalId = JSON.parse((firstRes.content[0] as { text: string }).text).proposalId as string;

    const listPendingRes = await callTeamTool(bobIdentity, 'team_list_proposals', { state: 'pending' });
    assert.equal(listPendingRes.isError, undefined);
    const pendingList = JSON.parse((listPendingRes.content[0] as { text: string }).text);
    assert.equal(pendingList.length, 1);
    assert.equal(pendingList[0].id, firstProposalId);

    const { teamExecutionEvidence } = await import('../src/assistant-teams/conversations.js');
    const evidence = await teamExecutionEvidence(liveBob, 'make it v2');
    assert.match(evidence, new RegExp(firstProposalId));
    assert.match(evidence, /Create \/developer v1/);
    assert.match(evidence, /supersedeProposalId/);

    // 4. Supersede the pending proposal with a revised v2 proposal.
    const revisedRes = await callTeamTool(bobIdentity, 'team_propose_changes', {
      summary: 'Create /developer v2',
      rationale: 'User requested v2 instructions',
      supersedeProposalId: firstProposalId,
      changes: [{ kind: 'create_member', role: 'developer', name: 'Developer v2', instructions: 'Updated v2 instructions' }],
    });
    assert.equal(revisedRes.isError, undefined);
    const revisedProposalId = JSON.parse((revisedRes.content[0] as { text: string }).text).proposalId as string;

    const oldProposal = (await getTeamProposal(firstProposalId))!;
    assert.equal(oldProposal.state, 'cancelled');
    assert.match(oldProposal.error ?? '', new RegExp(revisedProposalId));
    const newProposal = (await getTeamProposal(revisedProposalId))!;
    assert.equal(newProposal.state, 'pending');

    promptEnded(f.team.projectId, resolvedBob.destination.sessionId, liveBob.requestId);

    // 5. Paused waiting_for_human proposal assignments and stale pending inquiries (>30m) must NEVER swallow new requests via openTeamRequests.
    await finishPersonalAssistantTurn(f.team.executorAccountId, resolvedBob.profile.id, liveBob.requestId, 'Waiting for approval.');
    f.db.prepare('UPDATE assistant_team_work SET phase=? WHERE assignment_id=?').run('dispatched', liveBob.id);
    await recoverTeamWork(f.team.id);
    assert.equal((await getTeamAssignment(liveBob.id))!.state, 'waiting_for_human');

    const { openTeamRequests, createTeamInquiry } = await import('../src/assistant-teams/assignments.js');
    const oldInquiryMsg = await f.message('Old ignored request', { date: Math.floor((Date.now() - 2 * 3600_000) / 1000) });
    await createTeamInquiry(f.member, oldInquiryMsg, ['bob'], { kind: 'new' });

    const laterMsg = await f.message('check the status of the recent ci pipelines', { date: Math.floor(Date.now() / 1000) });
    const open = await openTeamRequests(laterMsg);
    assert.equal(open.some(r => r.id === liveBob.rootId), false, 'waiting_for_human proposal assignment must not swallow new messages');
    assert.equal(open.some(r => r.messageId === oldInquiryMsg.id), false, 'stale pending inquiry (>30m) must not swallow new messages');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
