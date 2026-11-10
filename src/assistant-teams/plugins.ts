import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { getSettings } from '../settings.js';
import { teamDatabase, TeamError, type AssistantTeam, type TeamRole } from './store.js';
import { activationDecision } from '../resource-activation.js';

/** Only explicit app-configured plugin directories; never Pi's user/package/global discovery. */
export function configuredTeamPlugins(): Array<{ name: string; directory: string }> {
  const roots = getSettings().resources.plugins;
  const entries = roots;
  const plugins = entries.map(directory => ({ name: path.basename(directory), directory: realpathSync(directory) }));
  if (new Set(plugins.map(plugin => plugin.name)).size !== plugins.length) throw new TeamError('Duplicate configured plugin names', 409);
  return plugins;
}
export function piPluginSkills(directory: string): string[] {
  const manifest = JSON.parse(readFileSync(path.join(directory, '.claude-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
  // Claude-specific execution surfaces are not Pi extensions. Never pretend they loaded.
  if (['commands', 'agents', 'hooks', 'mcpServers', 'outputStyles', 'lspServers'].some(key => manifest[key] !== undefined))
    throw new TeamError('Plugin has Claude-only components unsupported by Pi', 409);
  if (manifest.skills !== undefined && (!Array.isArray(manifest.skills) || manifest.skills.some(item => typeof item !== 'string')))
    throw new TeamError('Plugin skills are not Pi-compatible', 409);
  const roots = manifest.skills === undefined ? ['skills'] : manifest.skills as string[];
  const paths = roots.map(relative => {
    const candidate = path.resolve(directory, relative);
    if (!existsSync(candidate) || !statSync(candidate).isDirectory() || !realpathSync(candidate).startsWith(`${realpathSync(directory)}${path.sep}`))
      throw new TeamError('Plugin skill directory is missing or outside configured plugin', 409);
    return candidate;
  });
  if (!paths.length || paths.every(root => !readdirSync(root).length)) throw new TeamError('Plugin has no Pi-compatible skills', 409);
  return paths;
}
export async function teamPlugins(team: AssistantTeam, role: TeamRole) {
  const db = await teamDatabase();
  const rows = db.prepare('SELECT role, name, selected FROM assistant_team_plugins WHERE team_id=? AND (role=? OR role=\'\')').all(team.id, role) as { role: string; name: string; selected: number }[];
  const granted = new Set(rows.filter(row => row.role === '').map(row => row.name));
  const chosen = new Set(db.prepare('SELECT name FROM assistant_team_plugins WHERE team_id=? AND role=? AND selected=1').all(team.id, role).map(row => String(row.name)));
  return configuredTeamPlugins().filter(plugin => granted.has(plugin.name)).map(plugin => ({ ...plugin, selected: chosen.has(plugin.name), status: (() => { try { piPluginSkills(plugin.directory); if (!activationDecision('plugin', plugin.name, 'pi', false).enabled) throw new TeamError('Plugin activation disabled', 409); return 'ready'; } catch (error) { return error instanceof Error ? error.message : 'Plugin unsupported'; } })() }));
}
export async function selectedTeamPluginSkills(team: AssistantTeam, role: TeamRole): Promise<string[]> {
  const db = await teamDatabase();
  const names = db.prepare('SELECT name FROM assistant_team_plugins WHERE team_id=? AND role=? AND selected=1').all(team.id, role).map(row => String(row.name));
  const selected = (await teamPlugins(team, role)).filter(plugin => plugin.selected);
  if (selected.length !== names.length) throw new TeamError('Selected plugin was removed or its team grant revoked', 409);
  const paths: string[] = [];
  for (const plugin of selected) {
    if (plugin.status !== 'ready') throw new TeamError(`${plugin.name}: ${plugin.status}`, 409);
    paths.push(...piPluginSkills(plugin.directory));
  }
  return paths;
}
