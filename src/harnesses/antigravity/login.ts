import type { ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { currentRuntime } from "../../account-runtime.js";
import { stopProcessGroup } from "../process-lifecycle.js";
import type { ProfileLoginStatus } from "../../provider-profiles/login.js";
import type { ProviderProfile } from "../../provider-profiles/store.js";
import { prepareAntigravityProfile } from "../../antigravity-profiles/native.js";
import { invalidateAntigravityModels, probeAntigravity } from "./models.js";
import { antigravitySettings, spawnAntigravity } from "./process.js";

type Login = { owner: string; home: string; status: ProfileLoginStatus; child: ChildProcessWithoutNullStreams; submitted?: boolean };

function loginKey(profile?: ProviderProfile): string {
  return profile ? `profile:${profile.id}` : `machine:${currentRuntime().key}\n${antigravitySettings().configPath}`;
}

/** Only the vendor's Google authorization URL is exposed, never arbitrary process output. */
function googleUrl(output: string): string | undefined {
  for (const match of output.matchAll(/https:\/\/[^\s<>"'\x1b]+/g)) {
    if (!URL.canParse(match[0])) continue;
    const url = new URL(match[0]);
    if (url.origin === "https://accounts.google.com" && !url.username && !url.password && /^\/o\/oauth2\/(?:v2\/)?auth$/.test(url.pathname)) return url.href;
  }
  return undefined;
}

export class AntigravityLogins {
  private readonly logins = new Map<string, Login>();

  async start(owner: string, profile?: ProviderProfile): Promise<ProfileLoginStatus> {
    if (profile && (profile.provider !== "antigravity" || profile.owner !== owner)) throw new Error("Expected this owner's Google Antigravity profile");
    const key = loginKey(profile);
    if (this.logins.get(key)?.status.state === "waiting") throw new Error("Antigravity sign-in is already in progress on this node");
    const settings = antigravitySettings();
    const home = profile ? await prepareAntigravityProfile(profile) : settings.configPath ? path.dirname(settings.configPath) : currentRuntime().home;
    // The native terminal flow prints a URL and accepts a code over stdin. Never open
    // a browser on the server or inherit API-key/ADC authentication for this process.
    const child = spawnAntigravity(currentRuntime().home, ["acp", "--login"], { ...process.env, BROWSER: "true", SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 2" }, home);
    const login: Login = { owner, home, child, status: { state: "waiting", message: "Starting Google sign-in on this execution node" } };
    this.logins.set(key, login);
    this.watch(login);
    return structuredClone(login.status);
  }

  private watch(login: Login): void {
    let output = "";
    const receive = (chunk: string) => {
      if (login.status.state !== "waiting" || login.submitted) return;
      output = (output + chunk).slice(-16_384);
      const url = googleUrl(output);
      if (url) login.status.url = url;
      if (url && /Then paste the authorization code/i.test(output)) {
        login.status.message = "Open Google sign-in, then paste the authorization code or final redirect URL below";
        login.status.prompt = { type: "text", message: "Authorization code or redirect URL" };
      }
    };
    login.child.stdout.setEncoding("utf8").on("data", receive);
    login.child.stderr.setEncoding("utf8").on("data", receive);
    login.child.stdin.on("error", () => { if (login.status.state === "waiting") login.status = { state: "failed", message: "Could not submit the sign-in response. Start again." }; });
    const timeout = setTimeout(() => {
      login.status = { state: "failed", message: "Google sign-in timed out. Start again." };
      void stopProcessGroup(login.child, "Antigravity sign-in").catch(() => { login.status.message = "Could not stop sign-in. Restart this node before trying again."; });
    }, 15 * 60_000);
    timeout.unref();
    login.child.once("error", () => { clearTimeout(timeout); login.status = { state: "failed", message: "Could not start Google sign-in. Check Antigravity installation in Settings > Updates." }; });
    login.child.once("close", (code) => {
      clearTimeout(timeout);
      output = "";
      if (login.status.state !== "waiting") return;
      if (code !== 0) { login.status = { state: "failed", message: "Google sign-in failed. Start again." }; return; }
      login.status = { state: "waiting", message: "Verifying Google sign-in on this node" };
      void this.verify(login);
    });
  }

  private async verify(login: Login): Promise<void> {
    try {
      await probeAntigravity(os.tmpdir(), process.env, login.home);
      if (login.status.state === "waiting") {
        invalidateAntigravityModels();
        login.status = { state: "complete", message: "Google Antigravity is signed in on this execution node" };
      }
    } catch {
      if (login.status.state === "waiting") login.status = { state: "failed", message: "The CLI could not verify Google sign-in. Start again." };
    }
  }

  status(owner: string, profile?: ProviderProfile): ProfileLoginStatus | undefined {
    const login = this.logins.get(loginKey(profile));
    return login?.owner === owner ? structuredClone(login.status) : undefined;
  }

  answer(owner: string, answer: string, profile?: ProviderProfile): void {
    const login = this.logins.get(loginKey(profile));
    if (!login || login.owner !== owner || login.status.state !== "waiting" || !login.status.prompt) throw new Error("No pending Antigravity sign-in prompt");
    if (!answer.trim() || answer.length > 8192 || /[\r\n\0]/.test(answer)) throw new Error("Authorization response must be a nonempty single line of at most 8192 characters");
    login.submitted = true;
    delete login.status.prompt;
    delete login.status.url;
    login.status.message = "Completing Google sign-in on this node";
    login.child.stdin.end(`${answer.trim()}\n`);
  }

  async cancel(owner: string, profile?: ProviderProfile): Promise<void> {
    const login = this.logins.get(loginKey(profile));
    if (!login || login.owner !== owner || login.status.state !== "waiting") throw new Error("No Antigravity sign-in is in progress");
    login.status = { state: "cancelled", message: "Google sign-in cancelled" };
    if (login.child.exitCode === null && login.child.signalCode === null) await stopProcessGroup(login.child, "Antigravity sign-in");
  }

  busy(profile?: ProviderProfile): boolean { return this.logins.get(loginKey(profile))?.status.state === "waiting"; }
}

export const antigravityLogins = new AntigravityLogins();
