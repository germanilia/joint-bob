// The three S3 calls a backup needs (put a file, delete an object, ask whether a bucket takes a
// write), signed with AWS Signature Version 4. Written out here instead of taking the AWS SDK as a
// dependency: every machine in a cluster installs a release by itself, and the SDK is several
// hundred packages for three requests.
//
// Works with Amazon S3 and with a service that speaks its protocol at another address (`endpoint`).
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export interface S3Credentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

export interface S3Target {
  bucket: string;
  region: string;
  /** The address of an S3-compatible service. Absent for Amazon S3. */
  endpoint?: string;
}

/** A refusal by the service, with its own code (`AccessDenied`, `NoSuchBucket`, …) when it gave one. */
export class S3Error extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = "S3Error"; }
}

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** A request ends when the service sends nothing for this long, however large the upload. */
const IDLE_TIMEOUT_MS = 60_000;

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** Percent-encoding as the signature wants it: everything except A-Z a-z 0-9 - _ . ~ */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Where an object lives. A bucket with a dot in its name, and any other service, is addressed by path: its name cannot be a host under the service's certificate. */
export function s3ObjectUrl(target: S3Target, key: string): URL {
  const objectPath = key.split("/").map(encode).join("/");
  if (target.endpoint) return new URL(`${target.endpoint.replace(/\/+$/, "")}/${encode(target.bucket)}/${objectPath}`);
  if (target.bucket.includes(".")) return new URL(`https://s3.${target.region}.amazonaws.com/${encode(target.bucket)}/${objectPath}`);
  return new URL(`https://${target.bucket}.s3.${target.region}.amazonaws.com/${objectPath}`);
}

export interface SignedRequest { method: string; url: URL; headers?: Record<string, string>; payloadHash: string; credentials: S3Credentials; region: string; now?: Date }

/** The headers to send: the given ones, the date, the payload hash, the session token and the signature over all of them and the host. */
export function signS3Request(request: SignedRequest): Record<string, string> {
  const amzDate = (request.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const sent: Record<string, string> = {
    ...Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    "x-amz-content-sha256": request.payloadHash,
    "x-amz-date": amzDate,
    ...(request.credentials.sessionToken ? { "x-amz-security-token": request.credentials.sessionToken } : {}),
  };
  const signed: Record<string, string> = { ...sent, host: request.url.host };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name].trim().replace(/\s+/g, " ")}\n`).join("");
  const canonicalPath = request.url.pathname.split("/").map((segment) => encode(decodeURIComponent(segment))).join("/") || "/";
  const canonicalQuery = [...request.url.searchParams.entries()]
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`).join("&");
  const canonicalRequest = [request.method, canonicalPath, canonicalQuery, canonicalHeaders, names.join(";"), request.payloadHash].join("\n");
  const scope = `${day}/${request.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${request.credentials.secretAccessKey}`, day), request.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

interface Answer { status: number; headers: http.IncomingHttpHeaders; body: string }

function send(method: string, url: URL, headers: Record<string, string>, body?: { file: string } | { data: Buffer }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "http:" ? http : https).request(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => { if ((size += chunk.length) <= 64 * 1024) chunks.push(chunk); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.setTimeout(IDLE_TIMEOUT_MS, () => request.destroy(new Error(`${url.host} did not answer for ${IDLE_TIMEOUT_MS / 1000} seconds`)));
    request.on("error", reject);
    if (body && "file" in body) {
      const stream = createReadStream(body.file);
      stream.on("error", (error) => request.destroy(error));
      stream.pipe(request);
    } else request.end(body?.data);
  });
}

function refusal(action: string, target: S3Target, answer: Answer): S3Error {
  const code = /<Code>([^<]+)<\/Code>/.exec(answer.body)?.[1];
  const said = /<Message>([^<]+)<\/Message>/.exec(answer.body)?.[1];
  const region = answer.headers["x-amz-bucket-region"];
  const hint = typeof region === "string" && region !== target.region ? ` The bucket is in region ${region}.` : "";
  return new S3Error(`${action} in bucket ${target.bucket} was refused: ${answer.status}${code ? ` ${code}` : ""}${said ? ` (${said})` : ""}.${hint}`, answer.status, code);
}

/** Uploads a file as one object. The service checks the content against the hash that is signed, so a damaged upload is refused. */
export async function putS3Object(target: S3Target, credentials: S3Credentials, key: string, file: string, contentType = "application/octet-stream"): Promise<void> {
  const url = s3ObjectUrl(target, key);
  const [{ size }, payloadHash] = await Promise.all([stat(file), fileHash(file)]);
  const headers = signS3Request({ method: "PUT", url, headers: { "content-length": String(size), "content-type": contentType }, payloadHash, credentials, region: target.region });
  const answer = await send("PUT", url, headers, { file });
  if (answer.status !== 200) throw refusal(`Writing ${key}`, target, answer);
}

/** Uploads a few bytes as one object. */
export async function putS3Bytes(target: S3Target, credentials: S3Credentials, key: string, data: Buffer, contentType = "text/plain"): Promise<void> {
  const url = s3ObjectUrl(target, key);
  const headers = signS3Request({ method: "PUT", url, headers: { "content-length": String(data.length), "content-type": contentType }, payloadHash: sha256(data), credentials, region: target.region });
  const answer = await send("PUT", url, headers, { data });
  if (answer.status !== 200) throw refusal(`Writing ${key}`, target, answer);
}

/** Deletes an object. One that is already gone is not an error. */
export async function deleteS3Object(target: S3Target, credentials: S3Credentials, key: string): Promise<void> {
  const url = s3ObjectUrl(target, key);
  const headers = signS3Request({ method: "DELETE", url, payloadHash: EMPTY_HASH, credentials, region: target.region });
  const answer = await send("DELETE", url, headers);
  if (answer.status !== 204 && answer.status !== 200 && answer.status !== 404) throw refusal(`Deleting ${key}`, target, answer);
}

const execute = promisify(execFile);
const profiles = new Map<string, { credentials: S3Credentials; until: number }>();

/**
 * The credentials of an AWS profile on this machine (the default one for ""), asked from the AWS
 * CLI: it knows every way a profile can be set up (keys, single sign-on, a role, the machine's own
 * role). Kept until five minutes before they expire, ten minutes when they name no expiry.
 */
export async function awsProfileCredentials(profile: string, now = Date.now()): Promise<S3Credentials> {
  const held = profiles.get(profile);
  if (held && held.until > now) return held.credentials;
  // A service's PATH is short; the CLI is looked for where its installers put it as well.
  const PATH = [process.env.PATH ?? "", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", path.join(os.homedir(), ".local", "bin")].filter(Boolean).join(path.delimiter);
  let stdout: string;
  try {
    ({ stdout } = await execute("aws", ["configure", "export-credentials", "--format", "process", ...(profile ? ["--profile", profile] : [])], { env: { ...process.env, PATH }, timeout: 30_000 }));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") throw new Error("The AWS command line tool (aws) is not installed on this machine. Install it, or use an access key instead of a profile.");
    throw new Error(`The AWS command line tool gave no credentials for ${profile ? `profile ${profile}` : "the default profile"}: ${(failure.stderr ?? failure.message).trim().split("\n").at(-1)}`);
  }
  let parsed: { AccessKeyId?: unknown; SecretAccessKey?: unknown; SessionToken?: unknown; Expiration?: unknown };
  try { parsed = JSON.parse(stdout); } catch { throw new Error("The AWS command line tool answered with something that is not credentials"); }
  if (typeof parsed.AccessKeyId !== "string" || typeof parsed.SecretAccessKey !== "string") throw new Error("The AWS command line tool answered without an access key");
  const credentials: S3Credentials = { accessKeyId: parsed.AccessKeyId, secretAccessKey: parsed.SecretAccessKey, ...(typeof parsed.SessionToken === "string" ? { sessionToken: parsed.SessionToken } : {}) };
  const expires = typeof parsed.Expiration === "string" ? Date.parse(parsed.Expiration) : Number.NaN;
  profiles.set(profile, { credentials, until: Number.isFinite(expires) ? expires - 5 * 60_000 : now + 10 * 60_000 });
  return credentials;
}

/** Tests: forget the credentials kept for profiles. */
export function forgetAwsProfileCredentials(): void { profiles.clear(); }
