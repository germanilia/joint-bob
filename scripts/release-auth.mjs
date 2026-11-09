import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PUBLIC_RELEASE_API = "https://api.github.com/repos/germanilia/joint-bob-releases";

export function releaseApiBase() {
  const configured = (process.env.JOINT_BOB_RELEASE_API ?? PUBLIC_RELEASE_API).replace(/\/+$/, "");
  const url = new URL(configured);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Release feed URL must be HTTPS or loopback, without credentials or query parameters");
  }
  return configured;
}

export function isGithubReleaseApi(base) {
  return /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(base);
}

function validateToken(token) {
  if (!/^[A-Za-z0-9_]{1,4096}$/.test(token)) throw new Error("Invalid GitHub update token");
  return token;
}

export function saveReleaseToken(dataDirectory, token) {
  const value = validateToken(token.trim());
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(dataDirectory, "github-update-token");
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function readReleaseToken(dataDirectory) {
  let token;
  try { token = readFileSync(path.join(dataDirectory, "github-update-token"), "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("Configure this machine's private GitHub access with joint-bob update-token (token on stdin)");
    throw error;
  }
  return validateToken(token.trim());
}

/** Public updates never read credentials. Explicit private feeds keep tokens off CDN redirects. */
export async function fetchReleaseResource(url, dataDirectory, accept, timeoutMs) {
  const base = releaseApiBase();
  const githubRequest = isGithubReleaseApi(base) && url.startsWith(`${base}/releases/`);
  const headers = { Accept: accept, "User-Agent": "joint-bob-updater" };
  if (githubRequest && base !== PUBLIC_RELEASE_API) headers.Authorization = `Bearer ${readReleaseToken(dataDirectory)}`;
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { headers, signal, redirect: githubRequest ? "manual" : "follow" });
  if (!githubRequest || response.status < 300 || response.status >= 400) return response;
  const location = response.headers.get("location");
  const target = location && new URL(location, url);
  if (accept !== "application/octet-stream" || !target || target.protocol !== "https:" || target.username || target.password
      || !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(target.hostname)) {
    await response.body?.cancel();
    throw new Error("Unexpected release redirect");
  }
  await response.body?.cancel();
  return fetch(target.href, { headers: { Accept: accept, "User-Agent": "joint-bob-updater" }, signal, redirect: "error" });
}
