import type { GuardianRequest } from './rules.js';

const cliVariables = new Set(['BROWSER', 'WORKTREE', 'TASK', 'SECRET', 'NTFY', 'WEBHOOK_TITLE', 'WEBHOOK_MEMORY', 'ASSISTANT_MEMORY', 'ASSISTANT_SETUP'].map(name => `JOINT_BOB_${name}_CLI`));
const protectedBranch = /(?:^|\/)(?:dev|main|master|staging)$/;
const gitCommands = new Set('status diff log show add rm mv commit push pull fetch merge rebase reset restore rev-parse rev-list ls-files ls-tree cat-file blame grep config remote tag describe cherry-pick revert apply am clone init clean for-each-ref show-ref symbolic-ref update-ref update-index hash-object diff-tree diff-index merge-base name-rev shortlog reflog gc count-objects var version help branch checkout switch worktree stash'.split(' '));

/** Only literal shell words and && chains qualify. Substitutions, redirects and scripts stay checked. */
function literalCommands(command: string): string[][] | undefined {
  const commands: string[][] = [[]];
  let word = '', started = false, quote = '';
  const finish = () => { if (started) commands.at(-1)!.push(word); word = ''; started = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) { quote = ''; continue; }
      if (quote === '"' && c === '$' && word === '') {
        const cli = command.slice(i).match(/^\$(?:\{JOINT_BOB_[A-Z_]+_CLI\}|JOINT_BOB_[A-Z_]+_CLI)(?=")/);
        if (!cli) return undefined;
        word = cli[0]; i += cli[0].length - 1; continue;
      }
      if (quote === '"' && /[$`\\]/.test(c)) return undefined;
      word += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === '&' && command[i + 1] === '&') {
      finish();
      if (!commands.at(-1)!.length) return undefined;
      commands.push([]); i++;
    } else if (/\s/.test(c)) { if (c === '\n') return undefined; finish(); }
    else if (/[;$`\\|&<>()*?\[\]{}#~]/.test(c)) return undefined;
    else { word += c; started = true; }
  }
  finish();
  return quote || !commands.at(-1)!.length ? undefined : commands;
}

function gitPolicy(args: string[]): 'allow' | 'block' | undefined {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (['-C', '--git-dir', '--work-tree'].includes(args[i])) i += 2;
    else if (/^--(?:git-dir|work-tree)=/.test(args[i]) || ['--no-pager', '--bare', '--no-optional-locks'].includes(args[i])) i++;
    else return undefined;
  }
  const sub = args[i], rest = args.slice(i + 1);
  if (!gitCommands.has(sub)) return undefined;
  if (sub === 'push' && rest.some(arg => ['--mirror', '--prune'].includes(arg))) return 'block';
  const deleting = rest.some(arg => /^-[^-]*[dD]/.test(arg) || /^--delete(?:=|$)/.test(arg));
  if (['branch', 'update-ref', 'symbolic-ref', 'push'].includes(sub) && deleting && rest.some(arg => protectedBranch.test(arg.replace(/^(?:--delete=|-[a-zA-Z]*[dD])/, '')))) return 'block';
  if (sub === 'push' && rest.some(arg => /^\+?:/.test(arg) && protectedBranch.test(arg.slice(arg.indexOf(':') + 1)))) return 'block';
  if (sub === 'update-ref' && rest.some(arg => protectedBranch.test(arg)) && rest.some(arg => /^0{40}(?:0{24})?$/.test(arg))) return 'block';
  // stdin transactions and remote configuration can delete refs without naming them here.
  if (sub === 'update-ref' && rest.includes('--stdin')) return undefined;
  return 'allow';
}

function githubPolicy(args: string[]): 'allow' | 'block' | undefined {
  if (args.some(arg => /^--delete-branch(?:=|$)/.test(arg)) || args.includes('-d') && args[0] === 'pr' && args[1] === 'merge') return 'block';
  if (['pr', 'issue', 'run', 'workflow', 'release', 'search', 'status'].includes(args[0])) return 'allow';
  if (args[0] !== 'api') return undefined;
  const deletion = args.some(arg => arg === 'DELETE' || arg === '--method=DELETE' || arg === '-XDELETE');
  if (deletion) return args.some(arg => /\/git\/refs\/heads\//.test(arg) && protectedBranch.test(arg)) ? 'block' : undefined;
  return args.some(arg => /^repos\/[^/]+\/[^/]+\/(?:pulls|issues)(?:\/|$)/.test(arg)) ? 'allow' : undefined;
}

/** Deterministic defaults, before model rules. Never exempts an unrelated command in a shell chain. */
export function guardianCommandPolicy(request: GuardianRequest): 'allow' | 'block' | undefined {
  if (request.kind !== 'tool' || request.category !== 'commands') return undefined;
  const command = request.input.command ?? request.input.cmd;
  if (typeof command !== 'string') return undefined;
  // These names are server-supplied CLI entry points, not arbitrary similarly named files.
  const commands = literalCommands(command);
  if (!commands) return undefined;
  const decisions = commands.map(([executable, ...args]) => {
    if (executable === 'node' && args[0]?.startsWith('$') && cliVariables.has(args[0].replace(/^\$\{?|\}$/g, ''))) return 'allow';
    if (executable === 'git' || executable === '/usr/bin/git') return gitPolicy(args);
    if (executable === 'gh') return githubPolicy(args);
    return undefined;
  });
  if (decisions.includes('block')) return 'block';
  return decisions.every(decision => decision === 'allow') ? 'allow' : undefined;
}
