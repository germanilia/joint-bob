import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { resolveDataDirectory } from "./data-directory.js";
import { execFile } from "./subprocess.js";

const execute = promisify(execFile);
const RELEASES = "https://github.com/google-antigravity/antigravity-cli/releases/download/";
const TIMEOUT = 10 * 60_000;
const manifestSchema = z.object({ tag_name: z.string().regex(/^\d+\.\d+\.\d+$/), assets: z.array(z.object({ name: z.string(), browser_download_url: z.string(), digest: z.string().nullable() })) });

export function managedAntigravityExecutable(): string {
  return path.join(resolveDataDirectory(), "harnesses", "antigravity", "bin", "agy");
}

export function antigravityRelease(input: unknown, platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)) throw new Error(`Unsupported Antigravity platform: ${platform}/${arch}`);
  const manifest = manifestSchema.parse(input);
  const name = `agy_cli_${platform === "darwin" ? "mac" : "linux"}_${arch}.tar.gz`;
  const asset = manifest.assets.find((item) => item.name === name);
  if (!asset || asset.browser_download_url !== `${RELEASES}${manifest.tag_name}/${name}` || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) throw new Error("Antigravity release has no verified official package for this platform");
  return { version: manifest.tag_name, url: asset.browser_download_url, sha256: asset.digest!.slice(7) };
}

async function verifyInstall(staging: string, version: string): Promise<void> {
  const executable = path.join(staging, "bin", "agy");
  const info = await lstat(executable);
  if (!info.isFile() || !(info.mode & 0o111)) throw new Error("Antigravity package has no executable binary");
  const home = path.join(staging, "verification-home");
  await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home };
  const { stdout } = await execute(executable, ["--version"], { env, timeout: 15_000 });
  if (!stdout.includes(version)) throw new Error("Antigravity package version mismatch");
  await execute(executable, ["acp", "--help"], { env, timeout: 15_000 });
  await rm(home, { recursive: true });
}

export async function installManagedAntigravity(): Promise<void> {
  const response = await fetch("https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest", { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Antigravity release lookup failed: HTTP ${response.status}`);
  const release = antigravityRelease(await response.json());
  const root = path.dirname(path.dirname(managedAntigravityExecutable()));
  await mkdir(path.dirname(root), { recursive: true });
  const staging = await mkdtemp(`${root}-staging-`), backup = `${staging}-previous`;
  try {
    const download = await fetch(release.url, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!download.ok || !download.body) throw new Error(`Antigravity download failed: HTTP ${download.status}`);
    const archive = path.join(staging, "release.tar.gz"), hash = createHash("sha256");
    const digest = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
    await pipeline(download.body, digest, createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    if (hash.digest("hex") !== release.sha256) throw new Error("Antigravity download checksum mismatch; previous installation was not changed");
    await execute("tar", ["-xzf", archive, "-C", staging, "antigravity"], { timeout: TIMEOUT });
    await mkdir(path.join(staging, "bin"));
    await rename(path.join(staging, "antigravity"), path.join(staging, "bin", "agy"));
    await rm(archive);
    await verifyInstall(staging, release.version);
    const hadPrevious = existsSync(root);
    if (hadPrevious) await rename(root, backup);
    try { await rename(staging, root); }
    catch (error) { if (hadPrevious) await rename(backup, root); throw error; }
    if (hadPrevious) await rm(backup, { recursive: true });
  } finally { await rm(staging, { recursive: true, force: true }); }
}
