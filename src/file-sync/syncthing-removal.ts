import { execFile } from "node:child_process";
import { appendFile, lstat, readdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

/* Earlier releases moved project files with Syncthing. Built-in file sync does that now, and this
   module is all that still knows of Syncthing. Once per machine it takes out what Joint Bob put there:

   1. Joint Bob's folders (ids starting "joint-bob-") leave the local Syncthing's configuration, so
      that only built-in sync writes a project's files. A project is taken over only after that
      (adoption.ts): two tools writing one folder is the thing to avoid.
   2. Then what Joint Bob installed goes: the service it set up ("joint-bob-syncthing.service" or
      "com.joint-bob.syncthing"), its download in the runtime folder, the machines it added that share
      no folder any more, the connection it saved, and the ignore files and folder markers Syncthing
      kept in Joint Bob's folders.

   A Syncthing the person set up themselves, their own folders in it, and the files in every folder
   stay as they are: a service that still syncs a folder of theirs is left running. The module goes
   in a later release, when every machine has run it. */

/** Set once Joint Bob's folders are out of the local Syncthing (the name an earlier release gave it). */
const RELEASED_KEY = "syncthingRetired";
/** Set once everything else Joint Bob installed is gone too. */
const REMOVED_KEY = "syncthingRemoved";
const SAVED_ENDPOINT = "syncthing.endpoint", SAVED_API_KEY = "syncthing.apiKey";
const SERVICE_UNIT = "joint-bob-syncthing.service", LAUNCH_AGENT = "com.joint-bob.syncthing";
const DOWNLOAD_PREFIX = "syncthing-v";
const IGNORE_FILE = ".stignore", FOLDER_MARKER = ".stfolder";
/** All Syncthing itself puts in a folder marker: a note saying what the folder is. */
const MARKER_NOTE = /^syncthing-folder-.*\.txt$/;
/** Joint Bob named the machines it added after their node ids. */
const NODE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;

/** What a project's take-over shows while Syncthing still holds its folders (adoption.ts). */
export const WAITING_FOR_SYNCTHING = "Waiting for Syncthing on this machine to let go of Joint Bob's folders";

export interface SavedConnection { endpoint?: string; apiKey?: string }

export interface RemovalDeps {
  db: DatabaseSync;
  /** The connection this machine's settings held (endpoint, decrypted key); the environment and Syncthing's own config.xml fill what is missing. */
  stored?: () => SavedConnection | Promise<SavedConnection>;
  /** Forgets that saved connection, once nothing is left to ask Syncthing. */
  forget?: () => void | Promise<void>;
  /** The folders Joint Bob syncs, or once synced, on this machine: what Syncthing left in them goes. */
  roots?: () => string[];
  /** Where the text of the ignore files is kept before they are deleted; without it they are only deleted. */
  backupFile?: string;
  configPaths?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  /** Runs a system command; rejects when it fails. */
  run?: (command: string, args: string[]) => Promise<void>;
  /** The command lines of the processes running on this machine. */
  processes?: () => Promise<string[]>;
  log?: (message: string) => void;
}

/** "done": no Joint Bob folder is left in a Syncthing here, for good. "idle": no Syncthing that Joint Bob can ask runs now (stopped, or set up in a way Joint Bob cannot reach); asked again later. "waiting": one runs and still holds folders, or did not answer. */
export type RemovalOutcome = "done" | "idle" | "waiting";

interface Folder { id: string; label?: string; path?: string; devices?: Array<{ deviceID?: string }> }
type Api = (pathname: string, method?: string) => Promise<Response>;
/** What is known of a Syncthing on this machine: how to ask it, the configuration files found, and the service an earlier installer set up for it. */
interface Found { api?: Api; url?: string; apiKey?: string; configs: string[]; service?: string }

const execFileAsync = promisify(execFile);

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Where Syncthing keeps its configuration: the folder its environment names, else the platform's usual ones. */
function defaultConfigPaths(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const named = [env.STHOME, env.XDG_STATE_HOME && path.join(env.XDG_STATE_HOME, "syncthing"), env.XDG_CONFIG_HOME && path.join(env.XDG_CONFIG_HOME, "syncthing")];
  const usual = platform === "darwin" ? [path.join(home, "Library/Application Support/Syncthing")] : [path.join(home, ".local/state/syncthing"), path.join(home, ".config/syncthing")];
  return [...new Set([...named.filter((folder): folder is string => Boolean(folder)), ...usual])].map((folder) => path.join(folder, "config.xml"));
}

/** The file of the service an earlier installer set up for Joint Bob alone. */
function serviceFile(deps: RemovalDeps): string {
  const home = deps.home ?? os.homedir();
  return (deps.platform ?? process.platform) === "darwin" ? path.join(home, "Library/LaunchAgents", `${LAUNCH_AGENT}.plist`) : path.join(home, ".config/systemd/user", SERVICE_UNIT);
}

function elementText(xml: string, element: string): string | undefined {
  return new RegExp(`<${element}[^>]*>([^<]+)</${element}>`).exec(xml)?.[1]?.trim();
}

function loopback(value: string): boolean {
  try { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(value).hostname); } catch { return false; }
}

/** The interface a configuration file names, when it is on and has a key. */
function guiOf(xml: string): { url: string; apiKey: string } | undefined {
  const gui = /<gui\b([^>]*)>([\s\S]*?)<\/gui>/.exec(xml);
  if (!gui || /enabled="false"/.test(gui[1])) return undefined;
  const address = elementText(gui[2], "address"), apiKey = elementText(gui[2], "apikey");
  if (!address || !apiKey) return undefined;
  const host = address === "default" ? "127.0.0.1:8384" : address.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "127.0.0.1:");
  return { url: /^https?:\/\//.test(address) ? address.replace(/\/$/, "") : `${/tls="true"/.test(gui[1]) ? "https" : "http"}://${host}`, apiKey };
}

function unescapeXml(value: string): string {
  return value.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The folders a configuration file lists; the template under <defaults> has no id and is left out. */
function configFolders(xml: string): Folder[] {
  const folders: Folder[] = [];
  for (const match of xml.matchAll(/<folder\b([^>]*)>/g)) {
    const id = /\bid="([^"]*)"/.exec(match[1])?.[1], folderPath = /\bpath="([^"]*)"/.exec(match[1])?.[1], label = /\blabel="([^"]*)"/.exec(match[1])?.[1];
    if (id) folders.push({ id: unescapeXml(id), ...(label ? { label: unescapeXml(label) } : {}), ...(folderPath ? { path: unescapeXml(folderPath) } : {}) });
  }
  return folders;
}

async function locate(deps: RemovalDeps): Promise<Found> {
  const env = deps.env ?? process.env;
  const stored = await deps.stored?.() ?? {};
  const configs: string[] = [];
  for (const configPath of deps.configPaths ?? defaultConfigPaths(deps.home ?? os.homedir(), deps.platform ?? process.platform, env)) {
    try { configs.push(await readFile(configPath, "utf8")); } catch { /* not there */ }
  }
  const service = await isFile(serviceFile(deps)) ? serviceFile(deps) : undefined;
  const gui = configs.map(guiOf).find((found) => found !== undefined);
  const url = env.JOINT_BOB_SYNCTHING_URL?.trim() || stored.endpoint || gui?.url;
  const apiKey = env.JOINT_BOB_SYNCTHING_API_KEY?.trim() || stored.apiKey || gui?.apiKey;
  if (!url || !apiKey || !loopback(url)) return { url, apiKey, configs, service };
  const api: Api = async (pathname, method = "GET") => {
    const response = await (deps.fetch ?? fetch)(new URL(pathname, url), { method, headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Syncthing answered ${response.status}`);
    return response;
  };
  return { api, url, apiKey, configs, service };
}

/** Nothing on this machine speaks of a Syncthing: no way to ask one, no configuration of one, no service set up for one. */
function noTrace(found: Found): boolean { return !found.url && !found.apiKey && !found.configs.length && !found.service; }

function marked(db: DatabaseSync, key: string): boolean {
  try { return db.prepare("SELECT 1 FROM file_sync_config WHERE key = ?").get(key) !== undefined; } catch { return false; }
}

function mark(db: DatabaseSync, key: string): void {
  db.prepare("INSERT INTO file_sync_config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(new Date().toISOString()));
}

/** Whether Joint Bob's folders are out of this machine's Syncthing. */
export function syncthingReleased(db: DatabaseSync): boolean { return marked(db, RELEASED_KEY) || marked(db, REMOVED_KEY); }

/** Whether everything Joint Bob installed for Syncthing is gone from this machine. */
export function syncthingRemoved(db: DatabaseSync): boolean { return marked(db, REMOVED_KEY); }

/** A daemon that is not there (nothing listens on its address), as opposed to one that is slow or refuses the key. */
function notRunning(error: unknown): boolean {
  const code = ((error as { cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code);
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EADDRNOTAVAIL";
}

function ours(folder: Folder): boolean { return folder.id.startsWith("joint-bob-"); }

async function listFolders(api: Api): Promise<Folder[]> {
  const folders = await (await api("/rest/config/folders")).json() as unknown;
  if (!Array.isArray(folders)) throw new Error("Syncthing sent no folder list");
  return folders.filter((folder): folder is Folder => typeof (folder as { id?: unknown })?.id === "string");
}

/** Step 1: Joint Bob's folders leave the local Syncthing. A fresh list decides whether they did. */
async function releaseFolders(found: Found, log: (message: string) => void): Promise<{ outcome: RemovalOutcome; released: Folder[] }> {
  const { api } = found;
  if (!api) {
    // No trace of a Syncthing here: nothing to let go of, for good.
    if (noTrace(found)) return { outcome: "done", released: [] };
    // One is set up, but not in a way Joint Bob can ask (its interface is off, has no key, or is not on this machine).
    log("Joint Bob cannot ask the Syncthing set up on this machine for its folders. If it still holds folders named after Joint Bob projects, remove them there: built-in sync moves those files now");
    return { outcome: "idle", released: [] };
  }
  let folders: Folder[];
  try { folders = (await listFolders(api)).filter(ours); } catch (error) {
    if (notRunning(error)) return { outcome: "idle", released: [] };
    log(`Joint Bob could not ask this machine's Syncthing for its folders (${messageOf(error)}); projects it may still sync wait for built-in sync until it answers`);
    return { outcome: "waiting", released: [] };
  }
  for (const folder of folders) {
    try { await api(`/rest/config/folders/${encodeURIComponent(folder.id)}`, "DELETE"); } catch { /* the fresh list below decides */ }
  }
  let left: Folder[];
  try { left = folders.length ? (await listFolders(api)).filter(ours) : []; } catch { return { outcome: "waiting", released: [] }; }
  if (left.length) {
    log(`Syncthing on this machine still holds ${left.length} Joint Bob folder(s), the first being “${left[0].label?.trim() || left[0].id}”; built-in sync waits for it to let go`);
    return { outcome: "waiting", released: [] };
  }
  if (folders.length) log(`Joint Bob took its ${folders.length} folder(s) out of this machine's Syncthing; built-in sync moves those files now, and the files stay where they are`);
  return { outcome: "done", released: folders };
}

/**
 * The folders the local Syncthing still holds: asked of it while it runs (`live`, with the machines
 * each is shared with), read from its configuration when it does not. Undefined when it cannot be
 * told now: it runs and does not answer, or something speaks of a Syncthing whose configuration was
 * not found.
 */
async function heldFolders(found: Found): Promise<{ folders: Folder[]; live: boolean } | undefined> {
  if (found.api) {
    try { return { folders: await listFolders(found.api), live: true }; } catch (error) { if (!notRunning(error)) return undefined; }
  }
  if (found.configs.length) return { folders: found.configs.flatMap(configFolders), live: false };
  return noTrace(found) ? { folders: [], live: false } : undefined;
}

async function runCommand(command: string, args: string[]): Promise<void> {
  // The user's service manager is reached through the session bus, which a service's environment may not name.
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR ?? `/run/user/${os.userInfo().uid}`;
  const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtimeDirectory}/bus` };
  await execFileAsync(command, args, { env, timeout: COMMAND_TIMEOUT_MS });
}

async function runningCommands(): Promise<string[]> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "args="], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function isFile(file: string): Promise<boolean> {
  try { return (await lstat(file)).isFile(); } catch { return false; }
}

/**
 * The service an earlier installer set up for Joint Bob alone. "kept": it still syncs folders that
 * are not Joint Bob's, so stopping it would stop the person's own sync. "failed": it could not be
 * stopped, and is tried again at the next start.
 */
async function removeService(deps: RemovalDeps, others: Folder[], log: (message: string) => void): Promise<"none" | "removed" | "kept" | "failed"> {
  const darwin = (deps.platform ?? process.platform) === "darwin";
  const file = serviceFile(deps);
  if (!await isFile(file)) return "none";
  if (others.length) {
    log(`Joint Bob no longer uses the Syncthing it installed on this machine, and left it running: it still syncs ${others.length} folder(s) that are not Joint Bob's, the first being “${others[0].label?.trim() || others[0].id}”`);
    return "kept";
  }
  const run = deps.run ?? runCommand;
  try {
    if (darwin) {
      const target = `gui/${os.userInfo().uid}/${LAUNCH_AGENT}`;
      // Stopping an agent that is not loaded fails, so only a loaded one is stopped. Exit status 113 says this session
      // has no such agent; any other failure says nothing about whether it runs.
      const loaded = await run("launchctl", ["print", target]).then(() => true, (error: unknown) => {
        if ((error as { code?: unknown })?.code === 113) return false;
        throw error;
      });
      if (loaded) await run("launchctl", ["bootout", target]);
    } else {
      await run("systemctl", ["--user", "disable", "--now", SERVICE_UNIT]);
    }
  } catch (error) {
    log(`Joint Bob could not stop the Syncthing service it installed on this machine (${messageOf(error)}); it tries again at its next start`);
    return "failed";
  }
  await rm(file, { force: true });
  if (!darwin) await run("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  log("Joint Bob stopped and removed the Syncthing service it installed on this machine");
  return "removed";
}

/** The copies of Syncthing an earlier installer downloaded. False when one is still in use by the service just stopped: tried again at the next start. */
async function removeDownloads(deps: RemovalDeps, service: "none" | "removed" | "kept", log: (message: string) => void): Promise<boolean> {
  const env = deps.env ?? process.env;
  const root = env.JOINT_BOB_RUNTIME_DIR ?? env.MASTER_BOB_RUNTIME_DIR ?? path.join(deps.home ?? os.homedir(), ".local/share/joint-bob/runtime");
  let names: string[];
  try { names = (await readdir(root)).filter((name) => name.startsWith(DOWNLOAD_PREFIX)); } catch { return true; }
  // The service that was left running runs from it.
  if (!names.length || service === "kept") return true;
  const running = await (deps.processes ?? runningCommands)();
  let finished = true;
  for (const name of names) {
    const directory = path.join(root, name);
    if (running.some((command) => command.startsWith(`${directory}${path.sep}`))) {
      // Joint Bob's own service may still be going down; any other Syncthing started from this copy is the person's.
      if (service === "removed") finished = false;
      else log(`A Syncthing on this machine runs from the copy Joint Bob downloaded, so the copy was left in place: ${directory}`);
      continue;
    }
    await rm(directory, { recursive: true, force: true });
    log(`Joint Bob deleted the copy of Syncthing it had downloaded: ${directory}`);
  }
  return finished;
}

/** The machines Joint Bob added to a Syncthing that stays: one that shares no folder any more goes; the person's own are never touched. */
async function removeDevices(api: Api, held: Folder[], log: (message: string) => void): Promise<void> {
  const sharing = new Set(held.flatMap((folder) => (folder.devices ?? []).map((device) => device.deviceID)));
  const local = (await (await api("/rest/system/status")).json() as { myID?: unknown }).myID;
  const devices = await (await api("/rest/config/devices")).json() as Array<{ deviceID?: unknown; name?: unknown }>;
  if (typeof local !== "string" || !Array.isArray(devices)) throw new Error("Syncthing sent no device list");
  let removed = 0;
  for (const device of devices) {
    if (typeof device.deviceID !== "string" || device.deviceID === local || sharing.has(device.deviceID)) continue;
    if (typeof device.name !== "string" || !NODE_ID.test(device.name)) continue;
    await api(`/rest/config/devices/${encodeURIComponent(device.deviceID)}`, "DELETE");
    removed++;
  }
  if (removed) log(`Joint Bob took the ${removed} machine(s) it had added out of this machine's Syncthing; none of them shared a folder any more`);
}

function expandHome(folderPath: string, home: string): string {
  return path.resolve(folderPath === "~" ? home : folderPath.startsWith("~/") ? path.join(home, folderPath.slice(2)) : folderPath);
}

/** The folder as the filesystem names it, so that a link and the folder it points to compare equal; one that is not there keeps its written path. */
async function canonical(folder: string): Promise<string> {
  try { return await realpath(folder); } catch { return folder; }
}

async function removeIgnoreFile(file: string, backupFile: string | undefined): Promise<number> {
  if (!await isFile(file)) return 0;
  if (backupFile) {
    // Rules a person wrote into it by hand are in no other place.
    const text = await readFile(file, "utf8");
    await appendFile(backupFile, `// ${file}\n${text.endsWith("\n") ? text : `${text}\n`}\n`, { mode: 0o600 });
  }
  try { await unlink(file); return 1; } catch { return 0; }
}

async function removeFolderMarker(directory: string): Promise<number> {
  let names: string[];
  try {
    if (!(await lstat(directory)).isDirectory()) return 0;
    names = await readdir(directory);
  } catch { return 0; }
  // Anything else in it was put there by someone else.
  if (!names.every((name) => MARKER_NOTE.test(name))) return 0;
  try { await rm(directory, { recursive: true }); return 1; } catch { return 0; }
}

/** The ignore file and the folder marker Syncthing kept in each of Joint Bob's folders; a folder the local Syncthing still holds, or one inside such a folder, keeps them. */
async function removeMarkers(deps: RemovalDeps, folders: Folder[], released: Folder[], log: (message: string) => void): Promise<void> {
  const home = deps.home ?? os.homedir();
  const inUse = new Set(await Promise.all(folders.flatMap((folder) => folder.path ? [canonical(expandHome(folder.path, home))] : [])));
  // Each folder once, under the path it was given by.
  const roots = new Map<string, string>();
  for (const given of [...deps.roots?.() ?? [], ...released.flatMap((folder) => folder.path ? [folder.path] : [])]) {
    const root = expandHome(given, home), key = await canonical(root);
    if (!roots.has(key)) roots.set(key, root);
  }
  // Inside a folder Syncthing still holds, these are files it syncs: deleting one would delete it on that person's other machines.
  const held = (folder: string): boolean => [...inUse].some((parent) => folder === parent || folder.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`));
  let removed = 0;
  for (const [key, root] of roots) {
    if (held(key)) continue;
    removed += await removeIgnoreFile(path.join(root, IGNORE_FILE), deps.backupFile);
    removed += await removeFolderMarker(path.join(root, FOLDER_MARKER));
  }
  if (removed) log(`Joint Bob deleted ${removed} ignore file(s) and folder marker(s) that Syncthing kept in its folders${deps.backupFile ? `; the text of the ignore files is kept in ${deps.backupFile}` : ""}`);
}

/** Step 2: everything else Joint Bob installed. False when a part has to be tried again at the next start. */
async function removeInstalled(deps: RemovalDeps, found: Found, released: Folder[], log: (message: string) => void): Promise<boolean> {
  const held = await heldFolders(found);
  if (!held) {
    log("Joint Bob cannot tell what the Syncthing on this machine still syncs, so what it had installed for it stays for now; it asks again at its next start");
    return false;
  }
  const service = await removeService(deps, held.folders.filter((folder) => !ours(folder)), log);
  if (service === "failed") return false;
  const finished = await removeDownloads(deps, service, log);
  // Only with the list the running Syncthing gave: it alone says which machines each folder is shared with.
  if (found.api && held.live && service !== "removed") {
    await removeDevices(found.api, held.folders, log).catch((error) => {
      log(`Joint Bob could not take the machines it had added out of this machine's Syncthing (${messageOf(error)}); they share no folder with it any more`);
    });
  }
  await removeMarkers(deps, held.folders, released, log);
  if (finished) await deps.forget?.();
  return finished;
}

/** One attempt at step 2 per process and database: a part that keeps failing is tried again at the next start, not at every call. */
const attempted = new WeakSet<DatabaseSync>();

/** Takes Joint Bob out of this machine's Syncthing. Safe to call again: each call asks for the state anew. */
export async function removeSyncthing(deps: RemovalDeps): Promise<RemovalOutcome> {
  if (marked(deps.db, REMOVED_KEY)) return "done";
  const log = deps.log ?? ((message: string) => console.log(message));
  const found = await locate(deps);
  let released: Folder[] = [];
  if (!marked(deps.db, RELEASED_KEY)) {
    const step = await releaseFolders(found, log);
    if (step.outcome !== "done") return step.outcome;
    released = step.released;
    mark(deps.db, RELEASED_KEY);
  }
  if (!attempted.has(deps.db)) {
    attempted.add(deps.db);
    try {
      if (await removeInstalled(deps, found, released, log)) mark(deps.db, REMOVED_KEY);
    } catch (error) {
      log(`Joint Bob could not finish removing what it had installed for Syncthing (${messageOf(error)}); it tries again at its next start`);
    }
  }
  return "done";
}

/** The connection an earlier release saved in this node's settings. */
export async function savedConnection(): Promise<SavedConnection> {
  const { decrypt, setting } = await import("../settings-store.js");
  const endpoint = setting(SAVED_ENDPOINT)?.value, key = setting(SAVED_API_KEY);
  // A key this node can no longer decrypt is as good as none: Syncthing's own configuration has it too.
  try { return { ...(endpoint ? { endpoint } : {}), ...(key ? { apiKey: decrypt(key.value) } : {}) }; } catch { return endpoint ? { endpoint } : {}; }
}

export async function forgetSavedConnection(): Promise<void> {
  const { settingsDatabase } = await import("../settings-store.js");
  settingsDatabase().prepare("DELETE FROM node_settings WHERE key IN (?, ?)").run(SAVED_ENDPOINT, SAVED_API_KEY);
}
