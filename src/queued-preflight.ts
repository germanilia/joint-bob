import { claudeSubscriptionEnvironment, runtimeExec, usingServiceRuntime } from "./account-runtime.js";
import { execFile } from "./subprocess.js";
import { promisify } from "node:util";
import { z } from "zod";
import { getSettings } from "./settings.js";
import { claudeConfigPath } from "./claude-service.js";
import { selectedClaudeConfigPath, selectedClaudeEnvironment } from "./provider-profiles/execution.js";

const execute = promisify(execFile);
const authStatus = z.object({ loggedIn: z.boolean(), loginEnded: z.string().optional() }).passthrough();

function readStatus(stdout: unknown): z.infer<typeof authStatus> | undefined {
  try { return authStatus.parse(JSON.parse(String(stdout ?? ""))); } catch { return undefined; }
}

async function machineName(): Promise<string> {
  try { return (await (await import("./cluster.js")).getClusterNode()).name || "this machine"; } catch { return "this machine"; }
}

/** What a signed-out preflight tells the person: which sign-in is gone, where, and how to get it back. */
export async function claudeSignedOutMessage(onProfile: boolean, loginEnded?: string): Promise<string> {
  const machine = await machineName();
  if (onProfile) return `Claude did not accept the selected subscription profile's sign-in on ${machine}. Sign in to that profile again in Settings → Profiles, then press Force start.`;
  const ended = loginEnded === "time_limit" ? " Its sign-in reached Claude's time limit and ended." : "";
  return `Claude is signed out on ${machine}, and this conversation uses that machine's own sign-in.${ended} Run \`claude auth login\` on ${machine}, or choose a signed-in Claude subscription profile for this project in Settings → Profiles, then press Force start.`;
}

export async function preflightQueuedClaude(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const settings = getSettings().claude;
  const configPath = claudeConfigPath();
  // The CLI obeys the settings it finds in the person's folders, so it runs as that person.
  const launch = runtimeExec(settings.executable || "claude", ["auth", "status", "--json"], selectedClaudeEnvironment({ ...process.env, ...env, ...(configPath ? { CLAUDE_CONFIG_DIR: configPath } : {}), ...claudeSubscriptionEnvironment() }));
  let stdout: unknown;
  try {
    stdout = (await execute(launch.command, launch.args, {
      cwd: usingServiceRuntime() ? cwd : undefined, env: launch.env,
      timeout: 10_000, maxBuffer: 64 * 1024,
    })).stdout;
  } catch (error) {
    // `claude auth status` exits 1 when signed out and still prints its status.
    stdout = (error as { stdout?: unknown }).stdout;
    if (!readStatus(stdout)) throw error;
  }
  const status = readStatus(stdout) ?? authStatus.parse(JSON.parse(String(stdout)));
  if (!status.loggedIn) throw new Error(await claudeSignedOutMessage(Boolean(selectedClaudeConfigPath()), status.loginEnded));
}
