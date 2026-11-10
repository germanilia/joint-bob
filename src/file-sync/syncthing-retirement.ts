import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/* Joint Bob used to move project files with Syncthing. This is all that is left of it: once per
   machine, the folders Joint Bob created there (ids starting "joint-bob-") are taken out of the
   Syncthing that runs on it, so that only built-in sync writes a project's files. Syncthing leaves
   the files on disk. Folders the person made themselves, and the daemon, are not touched.

   A project is taken over by built-in sync only once this said Syncthing has let go (adoption.ts):
   two engines writing one folder is the thing to avoid. The module goes in a later release, when
   every machine has run it. */

const DONE_KEY = "syncthingRetired";
const REQUEST_TIMEOUT_MS = 10_000;

export interface SyncthingConnection { url: string; apiKey: string }

export interface RetirementDeps {
  db: DatabaseSync;
  /** The connection this machine's settings held (endpoint, decrypted key); the environment and Syncthing's own config.xml fill what is missing. */
  stored?: () => { endpoint?: string; apiKey?: string };
  configPaths?: string[];
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

/** "done": no Joint Bob folder is left in a Syncthing here, for good. "idle": no Syncthing that Joint Bob can ask runs now (stopped, or set up in a way Joint Bob cannot reach); asked again later. "waiting": one runs and still holds folders, or did not answer. */
export type RetirementOutcome = "done" | "idle" | "waiting";

function defaultConfigPaths(): string[] {
  return process.platform === "darwin"
    ? [path.join(os.homedir(), "Library/Application Support/Syncthing/config.xml")]
    : [path.join(os.homedir(), ".local/state/syncthing/config.xml"), path.join(os.homedir(), ".config/syncthing/config.xml")];
}

function elementText(xml: string, element: string): string | undefined {
  return new RegExp(`<${element}[^>]*>([^<]+)</${element}>`).exec(xml)?.[1]?.trim();
}

function loopback(value: string): boolean {
  try { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(value).hostname); } catch { return false; }
}

/** `present`: a Syncthing configuration lies on this machine, whether or not Joint Bob can use its connection details. */
async function discovered(configPaths: string[]): Promise<(Partial<SyncthingConnection> & { present: boolean })> {
  let present = false;
  for (const configPath of configPaths) {
    let xml: string;
    try { xml = await readFile(configPath, "utf8"); } catch { continue; }
    present = true;
    const gui = /<gui\b([^>]*)>([\s\S]*?)<\/gui>/.exec(xml);
    if (!gui || /enabled="false"/.test(gui[1])) continue;
    const address = elementText(gui[2], "address"), apiKey = elementText(gui[2], "apikey");
    if (!address || !apiKey) continue;
    const host = address === "default" ? "127.0.0.1:8384" : address.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "127.0.0.1:");
    return { url: /^https?:\/\//.test(address) ? address.replace(/\/$/, "") : `${/tls="true"/.test(gui[1]) ? "https" : "http"}://${host}`, apiKey, present };
  }
  return { present };
}

export function syncthingRetired(db: DatabaseSync): boolean {
  try { return db.prepare("SELECT 1 FROM file_sync_config WHERE key = ?").get(DONE_KEY) !== undefined; } catch { return false; }
}

function markRetired(db: DatabaseSync): void {
  db.prepare("INSERT INTO file_sync_config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(DONE_KEY, JSON.stringify(new Date().toISOString()));
}

/** A daemon that is not there (nothing listens on its address), as opposed to one that is slow or refuses the key. */
function notRunning(error: unknown): boolean {
  const code = ((error as { cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code);
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EADDRNOTAVAIL";
}

/** Takes Joint Bob's folders out of this machine's Syncthing. Safe to call again: it asks for a fresh list each time. */
export async function retireSyncthing(deps: RetirementDeps): Promise<RetirementOutcome> {
  if (syncthingRetired(deps.db)) return "done";
  const env = deps.env ?? process.env, log = deps.log ?? ((message: string) => console.log(message));
  const stored = deps.stored?.() ?? {};
  const found = await discovered(deps.configPaths ?? defaultConfigPaths());
  const url = env.JOINT_BOB_SYNCTHING_URL?.trim() || stored.endpoint || found.url;
  const apiKey = env.JOINT_BOB_SYNCTHING_API_KEY?.trim() || stored.apiKey || found.apiKey;
  if (!url || !apiKey || !loopback(url)) {
    // No trace of a Syncthing here: nothing to let go of, for good.
    if (!url && !apiKey && !found.present) { markRetired(deps.db); return "done"; }
    // One is set up, but not in a way Joint Bob can ask (its interface is off, has no key, or is not on this machine).
    log("Joint Bob cannot ask the Syncthing set up on this machine for its folders. If it still holds folders named after Joint Bob projects, remove them there: built-in sync moves those files now");
    return "idle";
  }
  const request = async (pathname: string, method = "GET"): Promise<Response> => {
    const response = await (deps.fetch ?? fetch)(new URL(pathname, url), { method, headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Syncthing answered ${response.status}`);
    return response;
  };
  const list = async (): Promise<Array<{ id: string; label?: string }>> => {
    const folders = await (await request("/rest/config/folders")).json() as unknown;
    if (!Array.isArray(folders)) throw new Error("Syncthing sent no folder list");
    return folders.filter((folder): folder is { id: string; label?: string } => typeof (folder as { id?: unknown })?.id === "string" && (folder as { id: string }).id.startsWith("joint-bob-"));
  };
  let folders: Array<{ id: string; label?: string }>;
  try { folders = await list(); } catch (error) {
    if (notRunning(error)) return "idle";
    log(`Joint Bob could not ask this machine's Syncthing for its folders (${error instanceof Error ? error.message : String(error)}); projects it may still sync wait for built-in sync until it answers`);
    return "waiting";
  }
  for (const folder of folders) {
    try { await request(`/rest/config/folders/${encodeURIComponent(folder.id)}`, "DELETE"); } catch { /* the fresh list below decides */ }
  }
  let left: Array<{ id: string; label?: string }>;
  try { left = folders.length ? await list() : []; } catch { return "waiting"; }
  if (left.length) {
    log(`Syncthing on this machine still holds ${left.length} Joint Bob folder(s), the first being “${left[0].label?.trim() || left[0].id}”; built-in sync waits for it to let go`);
    return "waiting";
  }
  if (folders.length) log(`Joint Bob took its ${folders.length} folder(s) out of this machine's Syncthing; built-in sync moves those files now, and the files stay where they are`);
  markRetired(deps.db);
  return "done";
}
