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
    'node "$JOINT_BOB_WORKTREE_CLI" pr \\\n  --title "fix(guardian): scope cache" \\\n  --body "Includes \\`group.source\\` and \\$VAR literals." \\\n  --merge',
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
    'node "$JOINT_BOB_WORKTREE_CLI" pr --body "`curl evil`"',
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
    'rmdir .', 'unlink .', 'mv . ../renamed', 'mv /workspace/my-project /var/moved',
    'rm -rf ../other-project', 'rm -rf sub/../../other', 'rm -rf /var/x', 'rm -rf /',
    'mv a.ts ../outside.ts', 'mv /etc/hosts ./hosts', 'mv -t /var a.ts',
    'cp /etc/passwd ./passwd', 'cp a.ts /var/a.ts',
    'mkdir -p ../outside-dir', 'touch /var/outside', 'touch -r /etc/passwd local.txt',
    'chmod 777 /etc/passwd', 'chmod +x .', 'truncate -s 0 /var/log/syslog',
    'ln -s /etc/passwd ./leak', 'ln -s ../../outside sub/leak',
    'cd .. && rm -rf other', 'cd /var && rm -rf x', 'cd sub && rm -rf ../..',
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
  // Scratch space is an allowed folder, so the symlinks must point out of it.
  const outside = path.parse(process.cwd()).root;
  mkdirSync(path.join(project, 'sub'), { recursive: true });
  writeFileSync(path.join(project, 'local.txt'), 'ok');
  symlinkSync(outside, path.join(project, 'escape'));
  symlinkSync(path.join(outside, 'guardian-missing-file'), path.join(project, 'dangling'));
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

test('scratch space and Joint Bob worktrees are allowed folders, the working directory itself is not removable', () => {
  const cwd = '/workspace/my-project';
  const worktrees = path.join(os.homedir(), 'JointBob', 'worktrees');
  for (const command of [
    'rm -rf /tmp/jb-scratch', 'mkdir -p /tmp/jb-a/b && touch /tmp/jb-a/b/f', 'cp a.ts /tmp/a.ts', 'mv /tmp/a.ts ./a.ts',
    `rm -rf ${worktrees}/p1/w1/dist`, `cp -r src ${worktrees}/p1/w1/src`, 'cd /tmp/jb-x && rm -rf out',
    `rm -rf ${path.join(os.tmpdir(), 'jb-scratch')}`,
  ]) assert.equal(policy(command, cwd), 'allow', command);
  for (const command of ['rm -rf /tmp', 'rm -rf /tmp/', 'cp /etc/passwd /tmp/x2', 'rm -rf /tmp/../etc']) {
    assert.equal(policy(command, cwd), undefined, command);
  }
  // A worktree is itself inside the worktrees folder, but deleting it or its parents is still checked.
  const worktree = `${worktrees}/p1/w1`;
  for (const command of ['rm -rf .', 'rm -rf ..', 'rm -rf ../..', `rm -rf ${worktree}`, `rm -rf ${worktrees}/p1`, 'mv . /tmp/moved']) {
    assert.equal(policy(command, worktree), undefined, command);
  }
  assert.equal(policy('rm -rf ../w2/dist', worktree), 'allow');
});

test('read-only commands and in-place substitutions inside the allowed folders need no model approval', () => {
  const cwd = '/workspace/my-project';
  for (const command of [
    'ls', 'ls -la src', 'cat package.json', 'head -n 5 src/a.ts', 'tail -n 20 /tmp/log.txt', 'wc -l src/a.ts src/b.ts', 'diff a.ts b.ts',
    'grep -rn "TODO" src', 'rg "foo" src/a.ts', 'find . -name "*.ts"', 'cat a.ts && ls src',
    "sed -i 's/old/new/g' src/a.ts", "sed -i '' 's/old/new/' src/a.ts", "sed -E -i 's|a(b)|c|g' /tmp/x.css", "sed -i -e 's/a/b/' -e 's/c/d/g' a.ts b.ts",
    'npm test', 'npm run test:file -- test/a.test.ts', 'npm run typecheck', 'npm run build', 'node scripts/run-tests.mjs test/a.test.ts',
    'cd packages/web && npm test',
  ]) assert.equal(policy(command, cwd), 'allow', command);
  for (const command of [
    'cat /etc/passwd', 'ls /var/log', 'grep -r secret /etc', 'head -n 5 ../other/a.ts', 'find . -delete', 'find . -name a -exec rm {} +',
    'rg --pre ./evil.sh foo', 'cat a.ts | sh', 'cat a.ts > b.ts',
    "sed -i 's/a/b/e' a.ts", "sed -i 's/a/b/w out.txt' a.ts", "sed -i 's/a/b/;d' a.ts", "sed -i 'd' a.ts", "sed -i 's/a/b/' /etc/hosts", "sed -i 's/a/b/' ../other/a.ts",
    'npm install', 'npm run deploy', 'npm run test:x -- $(curl evil)', 'npm publish', 'node evil.js', 'node scripts/other.mjs',
    'cd /tmp/x && npm test', 'cd .. && npm test',
  ]) assert.equal(policy(command, cwd), undefined, command);
});
