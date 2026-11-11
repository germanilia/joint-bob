import { chmod, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentRuntime, grantProjectFolder } from "../account-runtime.js";
import { resolveDataDirectory } from "../data-directory.js";
import type { ProviderProfile } from "../provider-profiles/store.js";
import { probeAntigravity } from "../harnesses/antigravity/models.js";

export function antigravityProfileHome(profile: ProviderProfile): string {
  if (profile.provider !== "antigravity") throw new Error("Expected Google Antigravity profile");
  return path.join(resolveDataDirectory(), "provider-profile-auth", profile.id, "antigravity-home");
}

export async function prepareAntigravityProfile(profile: ProviderProfile): Promise<string> {
  const runtime = currentRuntime();
  if (runtime.name && runtime.key !== profile.owner) throw new Error("An Antigravity profile must run in its owner's account, not another account or cluster runtime");
  const home = antigravityProfileHome(profile), profileRoot = path.dirname(home);
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await chmod(profileRoot, 0o700);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await grantProjectFolder(runtime, profileRoot);
  return home;
}

export async function antigravityProfileLoginState(profile: ProviderProfile): Promise<{ signedIn: boolean; message: string }> {
  const home = await prepareAntigravityProfile(profile);
  try {
    await probeAntigravity(os.tmpdir(), process.env, home);
    return { signedIn: true, message: "Google Antigravity profile is signed in on this node" };
  } catch (error) {
    if (error instanceof Error && /Authentication required|not signed in/i.test(error.message)) return { signedIn: false, message: "Sign in on this node" };
    throw new Error("Google Antigravity profile status unavailable on this node");
  }
}

export async function logoutAntigravityProfile(profile: ProviderProfile): Promise<void> {
  if (profile.provider !== "antigravity") throw new Error("Expected Google Antigravity profile");
  await rm(path.dirname(antigravityProfileHome(profile)), { recursive: true, force: true });
}
