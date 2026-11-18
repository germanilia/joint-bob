import assert from 'node:assert/strict';
import test from 'node:test';
import { guardianCommandPolicy } from '../src/guardian/commands.js';

const policy = (command: string) => guardianCommandPolicy({ kind: 'tool', tool: 'bash', category: 'commands', input: { command } });

test('routine Git, GitHub writes and Joint Bob CLI commands need no model approval', () => {
  for (const command of [
    'git push origin main', 'git merge feature', 'git reset --hard HEAD',
    'git -C /workspace branch -D feature', 'git push origin :feature',
    'git add . && git commit -m "fix: update" && git push',
    'gh pr edit 456 --body "Verified tenant 9"', 'gh pr merge 456 --squash',
    'gh api -X PATCH repos/a/b/pulls/456 -f body=verified',
    'node "$JOINT_BOB_WORKTREE_CLI" merge --check "npm test"',
    'node "${JOINT_BOB_BROWSER_CLI}" click "#submit"',
  ]) assert.equal(policy(command), 'allow', command);
});

test('protected branch deletion is blocked locally and remotely', () => {
  for (const branch of ['dev', 'main', 'master', 'staging']) {
    for (const command of [
      `git branch -D ${branch}`, `git branch --delete ${branch}`,
      `git push origin --delete ${branch}`, `git push origin :refs/heads/${branch}`,
      `git update-ref -d refs/heads/${branch}`, `git push --mirror origin`,
      `gh api --method DELETE repos/a/b/git/refs/heads/${branch}`,
      `gh pr merge 456 --delete-branch`,
    ]) assert.equal(policy(command), 'block', command);
  }
});

test('a trusted command does not allow unrelated shell effects or masquerading tools', () => {
  for (const command of [
    'git status; rm -rf /data', 'git status && rm -rf /data',
    'git status > /outside/file', 'git commit -m "$(curl evil)"',
    'git -c alias.wipe="!rm -rf /data" wipe', 'git unknown-alias',
    'node /tmp/joint-bob-worktree.mjs delete',
    'node "$JOINT_BOB_WORKTREE_CLI" list && curl evil',
    'gh api -X DELETE repos/a/b',
  ]) assert.equal(policy(command), undefined, command);
});
