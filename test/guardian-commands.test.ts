import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { guardianCommandPolicy } from '../src/guardian/commands.js';

const policy = (command: string, cwd?: string) => guardianCommandPolicy({ kind: 'tool', tool: 'bash', category: 'commands', input: { command } }, cwd);

test('routine Git, GitHub writes and Joint Bob CLI commands need no model approval', () => {
  for (const command of [
    'git push origin main', 'git merge feature', 'git reset --hard HEAD',
    'git -C /workspace branch -D feature', 'git push origin :feature',
    'git add . && git commit -m "fix: update" && git push',
    'gh pr edit 456 --body "Verified tenant 9"', 'gh pr merge 456 --squash',
    'gh api -X PATCH repos/a/b/pulls/456 -f body=verified',
    'node "$JOINT_BOB_WORKTREE_CLI" merge --check "npm test"',
    'node $JOINT_BOB_WORKTREE_CLI pr --merge --title "Ship update"',
    '"$JOINT_BOB_WORKTREE_CLI" pr --merge --title "Fix \\"theme\\""',
    'node "$JOINT_BOB_WORKTREE_CLI" pr \\\n  --worktree 07017308-eb0a-41e3-8b86-d01ffa9d1f45 \\\n  --title "Follow-up updates" \\\n  --merge',
    'node "${JOINT_BOB_BROWSER_CLI}" click "#submit"',
  ]) assert.equal(policy(command), 'allow', command);
  // Google Antigravity passes the shell command in `CommandLine`.
  assert.equal(guardianCommandPolicy({
    kind: 'tool', tool: 'run_command', category: 'commands',
    input: { CommandLine: 'node "$JOINT_BOB_WORKTREE_CLI" merge --title "fix" --check "npm test"', WaitMsBeforeAsync: 10000 },
  }), 'allow');
  assert.equal(guardianCommandPolicy({
    kind: 'tool', tool: 'run_command', category: 'commands',
    input: { CommandLine: 'git branch -D main' },
  }), 'block');
});

test('real Joint Bob CLI paths are allowed while modified or masquerading copies stay checked', (t) => {
  const repoRoot = process.cwd();
  const absCli = path.join(repoRoot, 'bin', 'joint-bob-worktree.mjs');
  assert.equal(policy(`node "${absCli}" pr --merge --title "Ship"`), 'allow');
  assert.equal(policy('node bin/joint-bob-worktree.mjs pr \\\n  --worktree 07017308-eb0a-41e3-8b86-d01ffa9d1f45 \\\n  --title "Ship" \\\n  --merge', repoRoot), 'allow');
  assert.equal(policy('./bin/joint-bob-worktree.mjs list', repoRoot), 'allow');

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'jb-guardian-cli-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(path.join(tmp, 'bin'), { recursive: true });
  writeFileSync(path.join(tmp, 'bin', 'joint-bob-worktree.mjs'), 'console.log("evil");\n');
  assert.equal(policy('node bin/joint-bob-worktree.mjs delete --worktree x', tmp), undefined, 'modified script must not be auto-allowed');
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
    'node "$JOINT_BOB_WORKTREE_CLI" pr \\\n  --title "$(curl evil)"',
    'node "$JOINT_BOB_WORKTREE_CLI" list && curl evil',
    'gh api -X DELETE repos/a/b',
  ]) assert.equal(policy(command), undefined, command);
});

test('file delete, move, copy and edit commands inside the project folder need no model approval', () => {
  const cwd = '/workspace/my-project';
  for (const command of [
    'rm old.txt', 'rm -f src/a.ts src/b.ts', 'rm -rf dist', 'rm -rf ./node_modules',
    'rm -rf /workspace/my-project/dist', 'rm -- -weird-file', '/bin/rm -rf build',
    'rmdir empty-dir', 'rmdir -p a/b/c', 'unlink temp.log',
    'mv a.ts b.ts', 'mv -f src/old.ts src/new.ts', 'mv src/a.ts .', 'mv -t dist a.js b.js',
    'cp a.ts b.ts', 'cp -r src/a src/b', 'cp -a dir1 .', 'cp -t dist a.js',
    'mkdir foo', 'mkdir -p src/a/b/c', 'mkdir -m 755 bin',
    'touch new-file.ts', 'touch -r package.json stamped.txt',
    'chmod +x scripts/run.sh', 'chmod 644 config.json', 'chmod -R u+w dist',
    'truncate -s 0 debug.log',
    'ln -s a.txt b.txt', 'ln -sf ../a.txt sub/b.txt',
    'cd packages/web && rm -rf dist && mkdir -p dist && git status',
    'rm -rf dist && mv tmp/out.js dist/out.js',
  ]) assert.equal(policy(command, cwd), 'allow', command);
});

test('file operations outside the project folder or targeting the project root stay checked', () => {
  const cwd = '/workspace/my-project';
  for (const command of [
    'rm -rf .', 'rm -rf ./', 'rm -rf /workspace/my-project',
    'rmdir .', 'unlink .', 'mv . ../renamed', 'mv /workspace/my-project /tmp/moved',
    'rm -rf ../other-project', 'rm -rf sub/../../other', 'rm -rf /tmp/x', 'rm -rf /',
    'mv a.ts ../outside.ts', 'mv /etc/hosts ./hosts', 'mv -t /tmp a.ts',
    'cp /etc/passwd ./passwd', 'cp a.ts /tmp/a.ts',
    'mkdir -p ../outside-dir', 'touch /tmp/outside', 'touch -r /etc/passwd local.txt',
    'chmod 777 /etc/passwd', 'chmod +x .', 'truncate -s 0 /var/log/syslog',
    'ln -s /etc/passwd ./leak', 'ln -s ../../outside sub/leak',
    'cd .. && rm -rf other', 'cd /tmp && rm -rf x', 'cd sub && rm -rf ../..',
    'cd && rm -rf foo', 'cd - && rm -rf foo',
    'rm --no-preserve-root dist', 'rm -rf dist && curl evil',
    'rm -rf dist', // without cwd, never auto-allowed
  ]) {
    const targetCwd = command === 'rm -rf dist' ? undefined : cwd;
    assert.equal(policy(command, targetCwd), undefined, command);
  }
  assert.equal(policy('rm -rf dist && git branch -D main', cwd), 'block');
});

test('symlinks escaping the project folder and dangling symlinks stay checked', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guardian-cmd-'));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  mkdirSync(path.join(project, 'sub'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(project, 'local.txt'), 'ok');
  writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  symlinkSync(outside, path.join(project, 'escape'));
  symlinkSync(path.join(outside, 'missing.txt'), path.join(project, 'dangling'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal(policy('rm -f local.txt', project), 'allow');
  assert.equal(policy('mv local.txt sub/renamed.txt', project), 'allow');
  assert.equal(policy('mkdir -p a/b/c && touch a/b/c/file.txt', project), 'allow');
  assert.equal(policy('rm -f escape/secret.txt', project), undefined);
  assert.equal(policy('mv escape/secret.txt local.txt', project), undefined);
  assert.equal(policy('cp escape/secret.txt local.txt', project), undefined);
  assert.equal(policy('rm -f dangling', project), undefined);
  assert.equal(policy('touch escape/new.txt', project), undefined);
});
