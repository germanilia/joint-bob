import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './assistant-team-fixture.js';
import { getTeam, saveTeamSettings } from '../src/assistant-teams/store.js';
import {
  deleteTeamMemory,
  listTeamMemoryChanges,
  listTeamMemoryTopics,
  readTeamMemoryTopic,
  revertTeamMemory,
  writeTeamMemory,
} from '../src/assistant-teams/memory.js';
import { TEAM_MEMORY_TOOLS } from '../src/assistant-teams/tools.js';
import { acceptTeamAssignment } from '../src/assistant-teams/assignments.js';
import { readAssignmentExecutionDetail } from '../src/assistant-teams/proposals.js';

test('team custom name, allowBob, and voiceProvider/kokoroVoice persist across saveTeamSettings', async () => {
  const f = await fixture();
  const initial = await getTeam(f.team.id);
  assert.equal(initial.name, null);

  const updated = await saveTeamSettings(
    f.member,
    { askThreshold: 0.75, actThreshold: 0.9, allowBob: false, voiceProvider: 'kokoro', kokoroVoice: 'am_michael' },
    initial.revision,
    'Home Chief of Staff',
  );
  assert.equal(updated.name, 'Home Chief of Staff');
  assert.equal(updated.settings.allowBob, false);
  assert.equal(updated.settings.voiceProvider, 'kokoro');
  assert.equal(updated.settings.kokoroVoice, 'am_michael');

  const reloaded = await getTeam(f.team.id);
  assert.equal(reloaded.name, 'Home Chief of Staff');
  assert.equal(reloaded.settings.voiceProvider, 'kokoro');
  assert.equal(reloaded.settings.allowBob, false);
});

test('team and member memory support full CRUD (create, read, update, list all scopes, delete, revert)', async () => {
  const f = await fixture();

  // Create collective team memory and member-scoped memory
  await writeTeamMemory(f.member, {
    topic: 'routing-rules',
    expectedRevision: 0,
    description: 'Shared routing rules',
    body: 'Bills go to /finance.',
    sourceMessageIds: [],
    scope: 'team',
  });
  await writeTeamMemory(
    f.member,
    {
      topic: 'accounts',
      expectedRevision: 0,
      description: 'Finance accounts',
      body: 'Read-only bank check.',
      sourceMessageIds: [],
      scope: 'member',
    },
    'qa',
  );

  // List all scopes returns both collective and per-member topics with role metadata
  const allTopics = await listTeamMemoryTopics(f.member, 0, 50, 'all');
  assert.equal(allTopics.length, 2);
  const teamTopic = allTopics.find(t => t.name === 'routing-rules');
  const memberTopic = allTopics.find(t => t.name === 'accounts');
  assert.equal(teamTopic?.scope, 'team');
  assert.equal(teamTopic?.role, null);
  assert.equal(memberTopic?.scope, 'member');
  assert.equal(memberTopic?.role, 'qa');

  // Update member topic
  const updated = await writeTeamMemory(
    f.member,
    {
      topic: 'accounts',
      expectedRevision: 1,
      description: 'Finance accounts',
      body: 'Read-only bank check + Gmail invoices.',
      sourceMessageIds: [],
      scope: 'member',
    },
    'qa',
  );
  assert.equal(updated.revision, 2);

  // Delete member topic and confirm it disappears from active list
  const deleted = await deleteTeamMemory(f.member, 'accounts', 2, 'qa');
  assert.equal(deleted.revision, 3);
  const afterDelete = await listTeamMemoryTopics(f.member, 0, 50, 'all');
  assert.equal(afterDelete.some(t => t.name === 'accounts'), false);
  const readDeleted = await readTeamMemoryTopic(f.member, 'accounts', 'qa');
  assert.equal(readDeleted.text, '');

  // Revert deletion restores the topic cleanly
  const changes = await listTeamMemoryChanges(f.member, 0, 20);
  const deleteChange = changes.find(c => c.topic === 'accounts' && c.revision === 3);
  assert.ok(deleteChange);
  await revertTeamMemory(f.member, deleteChange.id, 3);
  const restored = await readTeamMemoryTopic(f.member, 'accounts', 'qa');
  assert.match(restored.body, /Gmail invoices/);

  // Tool catalog exposes team_memory_delete
  assert.ok(TEAM_MEMORY_TOOLS.some(t => t.name === 'team_memory_delete'));
});

test('readAssignmentExecutionDetail returns redacted assignment details and handles missing conversation cleanly', async () => {
  const f = await fixture();
  const [assignment] = await acceptTeamAssignment(f.member, await f.message('/qa check build logs'), ['qa'], null);
  const detail = await readAssignmentExecutionDetail(f.team.id, assignment.id);
  assert.equal(detail.assignmentId, assignment.id);
  assert.equal(detail.role, 'qa');
  assert.equal(detail.delegated, false);
  assert.equal(detail.projectId, f.team.projectId);
  assert.ok(Array.isArray(detail.toolCalls));
});
