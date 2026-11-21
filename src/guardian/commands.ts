import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { GuardianRequest } from './rules.js';

const cliVariables = new Set(['BROWSER', 'WORKTREE', 'TASK', 'SECRET', 'NTFY', 'WEBHOOK_TITLE', 'WEBHOOK_MEMORY', 'ASSISTANT_MEMORY', 'ASSISTANT_SETUP'].map(name => `JOINT_BOB_${name}_CLI`));
const protectedBranch = /(?:^|\/)(?:dev|main|master|staging)$/;
const gitCommands = new Set('status diff log show add rm mv commit push pull fetch merge rebase reset restore rev-parse rev-list ls-files ls-tree cat-file blame grep config remote tag describe cherry-pick revert apply am clone init clean for-each-ref show-ref symbolic-ref update-ref update-index hash-object diff-tree diff-index merge-base name-rev shortlog reflog gc count-objects var version help branch checkout switch worktree stash'.split(' '));
const standardBin = /^(?:\/(?:usr\/)?bin\/)?([a-z]+)$/;

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

function insideDir(rootCwd: string, baseDir: string, rawPath: string, allowRoot: boolean): boolean {
  if (!rootCwd || !path.isAbsolute(rootCwd) || !rawPath || rawPath.includes('\0')) return false;
  const normalizedRoot = path.resolve(rootCwd);
  const candidate = path.resolve(baseDir, rawPath);
  const lexRel = path.relative(normalizedRoot, candidate);
  if (lexRel === '..' || lexRel.startsWith(`..${path.sep}`) || path.isAbsolute(lexRel)) return false;
  if (!allowRoot && lexRel === '') return false;

  let realRoot: string;
  try {
    realRoot = realpathSync(normalizedRoot);
  } catch {
    // Non-existent virtual cwd (e.g. unit tests): lexical check above already verified containment.
    return true;
  }

  const tail: string[] = [];
  let cur = candidate;
  while (true) {
    try {
      const real = realpathSync(cur);
      const resolved = tail.length ? path.resolve(real, ...tail.reverse()) : real;
      const realRel = path.relative(realRoot, resolved);
      if (realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) return false;
      return allowRoot || realRel !== '';
    } catch {
      try {
        if (lstatSync(cur).isSymbolicLink()) return false;
      } catch {
        // Path segment does not exist yet; continue walking up to nearest existing ancestor.
      }
      const parent = path.dirname(cur);
      if (parent === cur) return false;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

interface FlagSpec {
  short?: string;
  long?: string[];
  valueShort?: string;
  valueLong?: string[];
}

interface ParsedFlags {
  flags: Set<string>;
  values: Map<string, string[]>;
  positional: string[];
}

function parseFlags(args: string[], spec: FlagSpec): ParsedFlags | undefined {
  const short = new Set(spec.short ?? '');
  const long = new Set(spec.long ?? []);
  const valueShort = new Set(spec.valueShort ?? '');
  const valueLong = new Set(spec.valueLong ?? []);
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  const addValue = (key: string, val: string) => {
    const list = values.get(key);
    if (list) list.push(val);
    else values.set(key, [val]);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { positional.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        const key = arg.slice(0, eq);
        if (!valueLong.has(key)) return undefined;
        addValue(key, arg.slice(eq + 1));
      } else if (long.has(arg)) {
        flags.add(arg);
      } else if (valueLong.has(arg)) {
        if (i + 1 >= args.length) return undefined;
        addValue(arg, args[++i]);
      } else return undefined;
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const ch = arg[j];
        if (short.has(ch)) {
          flags.add(`-${ch}`);
        } else if (valueShort.has(ch)) {
          if (j + 1 < arg.length) { addValue(`-${ch}`, arg.slice(j + 1)); break; }
          if (i + 1 >= args.length) return undefined;
          addValue(`-${ch}`, args[++i]);
          break;
        } else return undefined;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, values, positional };
}

function targetDirValues(parsed: ParsedFlags): string[] {
  return [...(parsed.values.get('-t') ?? []), ...(parsed.values.get('--target-directory') ?? [])];
}

function workspaceFilePolicy(executable: string, args: string[], rootCwd: string, activeCwd: string): { decision?: 'allow'; nextCwd?: string } {
  const match = executable.match(standardBin);
  if (!match) return {};
  const cmd = match[1];
  const inside = (raw: string, allowRoot: boolean) => insideDir(rootCwd, activeCwd, raw, allowRoot);

  if (cmd === 'cd') {
    const rest = args[0] === '--' ? args.slice(1) : args;
    if (rest.length !== 1 || !rest[0] || rest[0].startsWith('-')) return {};
    if (!inside(rest[0], true)) return {};
    return { decision: 'allow', nextCwd: path.resolve(activeCwd, rest[0]) };
  }

  if (cmd === 'rm') {
    const parsed = parseFlags(args, { short: 'frRdiIv', long: ['--force', '--recursive', '--dir', '--interactive', '--verbose', '--one-file-system'] });
    if (!parsed || !parsed.positional.length) return {};
    return parsed.positional.every(p => inside(p, false)) ? { decision: 'allow' } : {};
  }

  if (cmd === 'rmdir') {
    const parsed = parseFlags(args, { short: 'pv', long: ['--parents', '--ignore-fail-on-non-empty', '--verbose'] });
    if (!parsed || !parsed.positional.length) return {};
    return parsed.positional.every(p => inside(p, false)) ? { decision: 'allow' } : {};
  }

  if (cmd === 'unlink') {
    const parsed = parseFlags(args, {});
    if (!parsed || parsed.positional.length !== 1) return {};
    return inside(parsed.positional[0], false) ? { decision: 'allow' } : {};
  }

  if (cmd === 'mv') {
    const parsed = parseFlags(args, { short: 'finuvT', long: ['--force', '--interactive', '--no-clobber', '--update', '--verbose', '--no-target-directory'], valueShort: 't', valueLong: ['--target-directory'] });
    if (!parsed) return {};
    const targetDirs = targetDirValues(parsed);
    if (targetDirs.length > 1) return {};
    if (targetDirs.length === 1) {
      if (!parsed.positional.length || !inside(targetDirs[0], true)) return {};
      return parsed.positional.every(p => inside(p, false)) ? { decision: 'allow' } : {};
    }
    if (parsed.positional.length < 2) return {};
    const sources = parsed.positional.slice(0, -1);
    const dest = parsed.positional.at(-1)!;
    return sources.every(p => inside(p, false)) && inside(dest, true) ? { decision: 'allow' } : {};
  }

  if (cmd === 'cp') {
    const parsed = parseFlags(args, { short: 'afinprRuvLPHTd', long: ['--archive', '--force', '--interactive', '--no-clobber', '--preserve', '--recursive', '--update', '--verbose', '--no-target-directory', '--no-dereference'], valueShort: 't', valueLong: ['--target-directory'] });
    if (!parsed) return {};
    const targetDirs = targetDirValues(parsed);
    if (targetDirs.length > 1) return {};
    if (targetDirs.length === 1) {
      if (!parsed.positional.length || !inside(targetDirs[0], true)) return {};
      return parsed.positional.every(p => inside(p, false)) ? { decision: 'allow' } : {};
    }
    if (parsed.positional.length < 2) return {};
    const sources = parsed.positional.slice(0, -1);
    const dest = parsed.positional.at(-1)!;
    return sources.every(p => inside(p, false)) && inside(dest, true) ? { decision: 'allow' } : {};
  }

  if (cmd === 'mkdir') {
    const parsed = parseFlags(args, { short: 'pv', long: ['--parents', '--verbose'], valueShort: 'm', valueLong: ['--mode'] });
    if (!parsed || !parsed.positional.length) return {};
    return parsed.positional.every(p => inside(p, true)) ? { decision: 'allow' } : {};
  }

  if (cmd === 'touch') {
    const parsed = parseFlags(args, { short: 'acm', long: ['--no-create'], valueShort: 'tdr', valueLong: ['--date', '--reference'] });
    if (!parsed || !parsed.positional.length) return {};
    const refs = [...(parsed.values.get('-r') ?? []), ...(parsed.values.get('--reference') ?? [])];
    if (!refs.every(r => inside(r, true))) return {};
    return parsed.positional.every(p => inside(p, true)) ? { decision: 'allow' } : {};
  }

  if (cmd === 'chmod') {
    const parsed = parseFlags(args, { short: 'Rvcf', long: ['--recursive', '--verbose', '--changes', '--silent', '--quiet'] });
    if (!parsed || parsed.positional.length < 2) return {};
    const [mode, ...files] = parsed.positional;
    if (!/^(?:[0-7]{3,4}|[ugoa]*[+-=][rwxXst]+(?:,[ugoa]*[+-=][rwxXst]+)*)$/.test(mode)) return {};
    return files.every(p => inside(p, false)) ? { decision: 'allow' } : {};
  }

  if (cmd === 'truncate') {
    const parsed = parseFlags(args, { short: 'c', long: ['--no-create'], valueShort: 's', valueLong: ['--size'] });
    if (!parsed || !parsed.positional.length) return {};
    return parsed.positional.every(p => inside(p, false)) ? { decision: 'allow' } : {};
  }

  if (cmd === 'ln') {
    const parsed = parseFlags(args, { short: 'sfnvT', long: ['--symbolic', '--force', '--no-dereference', '--verbose', '--no-target-directory'], valueShort: 't', valueLong: ['--target-directory'] });
    if (!parsed) return {};
    const symbolic = parsed.flags.has('-s') || parsed.flags.has('--symbolic');
    const targetDirs = targetDirValues(parsed);
    if (targetDirs.length > 1) return {};
    if (targetDirs.length === 1) {
      if (!parsed.positional.length || !inside(targetDirs[0], true)) return {};
      const linkBase = symbolic ? path.resolve(activeCwd, targetDirs[0]) : activeCwd;
      return parsed.positional.every(t => insideDir(rootCwd, linkBase, t, false)) ? { decision: 'allow' } : {};
    }
    if (parsed.positional.length !== 2) return {};
    const [target, link] = parsed.positional;
    if (!inside(link, false)) return {};
    const resolvedLink = path.resolve(activeCwd, link);
    let linkBase = activeCwd;
    if (symbolic) {
      let isDir = false;
      try { isDir = lstatSync(resolvedLink).isDirectory(); } catch { /* not an existing directory */ }
      linkBase = isDir ? resolvedLink : path.dirname(resolvedLink);
    }
    return insideDir(rootCwd, linkBase, target, false) ? { decision: 'allow' } : {};
  }

  return {};
}

/** Deterministic defaults, before model rules. Never exempts an unrelated command in a shell chain. */
export function guardianCommandPolicy(request: GuardianRequest, cwd?: string): 'allow' | 'block' | undefined {
  if (request.kind !== 'tool' || request.category !== 'commands') return undefined;
  const command = request.input.command ?? request.input.cmd;
  if (typeof command !== 'string') return undefined;
  // These names are server-supplied CLI entry points, not arbitrary similarly named files.
  const commands = literalCommands(command);
  if (!commands) return undefined;
  let activeCwd = cwd && path.isAbsolute(cwd) ? path.resolve(cwd) : undefined;
  const decisions: Array<'allow' | 'block' | undefined> = [];
  for (const [executable, ...args] of commands) {
    if (executable === 'node' && args[0]?.startsWith('$') && cliVariables.has(args[0].replace(/^\$\{?|\}$/g, ''))) {
      decisions.push('allow');
    } else if (executable === 'git' || executable === '/usr/bin/git') {
      decisions.push(gitPolicy(args));
    } else if (executable === 'gh') {
      decisions.push(githubPolicy(args));
    } else if (cwd && activeCwd) {
      const result = workspaceFilePolicy(executable, args, cwd, activeCwd);
      if (result.nextCwd) activeCwd = result.nextCwd;
      decisions.push(result.decision);
    } else {
      decisions.push(undefined);
    }
  }
  if (decisions.includes('block')) return 'block';
  return decisions.every(decision => decision === 'allow') ? 'allow' : undefined;
}
