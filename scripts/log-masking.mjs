import { readFileSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";

const values = new Set();
let revision = 0;
let indexedRevision = -1;
let byFirstCharacter = new Map();
const CREDENTIAL_NAME = /(?:^|_)(?:secret(?:_access_key)?|password|passwd|token|api_?key|private_key|credentials|authorization|connection_string|database_url|mongodb_uri|aws_access_key_id)$/i;

/** Retain old values too: errors from an already-running command can arrive after rotation. */
export function registerLogSecrets(secrets) {
  for (const secret of secrets) {
    if (!secret) continue;
    for (const value of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]) {
      if (!values.has(value)) { values.add(value); revision++; }
    }
  }
}

/** Only for in-memory transfer to task log writers. Never persist or return through an API. */
export function logSecretValues() { return [...values]; }

function registerJsonSecrets(value, name = "") {
  if (typeof value === "string") {
    if (CREDENTIAL_NAME.test(name) || name === "value") registerLogSecrets([value]);
  } else if (Array.isArray(value)) value.forEach(item => registerJsonSecrets(item, name));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => registerJsonSecrets(item, key));
}

export function registerEnvironmentLogSecrets(env) {
  const attached = JSON.parse(env.JOINT_BOB_SECRET_ENV_NAMES || "[]");
  const names = new Set([...attached, ...Object.keys(env).filter(name => CREDENTIAL_NAME.test(name))]);
  for (const name of names) {
    const value = env[name];
    if (typeof value !== "string" || !value) continue;
    registerLogSecrets([value]);
    // File-based credentials are injected as paths, but their contents are secret as well.
    if (!value.startsWith("/")) continue;
    let info;
    try { info = statSync(value); } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") continue; throw error; }
    if (!info.isFile() || info.size > 1024 * 1024) continue;
    const content = readFileSync(value, "utf8");
    registerLogSecrets([content]);
    let parsed;
    try { parsed = JSON.parse(content); } catch { continue; }
    registerJsonSecrets(parsed);
  }
}

function secretIndex() {
  if (indexedRevision !== revision) {
    byFirstCharacter = new Map();
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
      const entries = byFirstCharacter.get(value[0]) || [];
      entries.push(value);
      byFirstCharacter.set(value[0], entries);
    }
    indexedRevision = revision;
  }
  return byFirstCharacter;
}

/** Shape matching also covers credentials not saved in Joint Bob. */
function maskCredentialFields(text) {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "***")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_|github_pat_|glpat-|xox[abprs]-|sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{20,}\b/g, "***")
    .replace(/\b(Bearer|Basic)\s+[^\s"',}]+/gi, "$1 ***")
    .replace(/(\b[\w-]*(?:secret|password|passwd|token|api_?key|private_key)["']?\s*[=:]\s*)("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;}\[\]{}]+)/gi, (_match, prefix, value) => {
      if (/^(?:true|false|null)$/.test(value)) return `${prefix}${value}`;
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
      return `${prefix}${quote}***${quote}`;
    })
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1***@");
}

export function createLogMasker() {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  function consume(final) {
    const index = secretIndex();
    let result = "";
    let position = 0;
    while (position < pending.length) {
      const candidates = index.get(pending[position]) || [];
      const partial = candidates.some(value => value.length > pending.length - position && value.startsWith(pending.slice(position)));
      if (partial && !final) break;
      const match = candidates.find(value => pending.startsWith(value, position));
      if (match) { result += "***"; position += match.length; continue; }
      // At EOF an unfinished prefix cannot become a secret. Preserve ordinary trailing text.
      if (partial) { result += pending.slice(position); position = pending.length; break; }
      result += pending[position++];
    }
    pending = pending.slice(position);
    return maskCredentialFields(result);
  }
  return {
    write(chunk) { pending += typeof chunk === "string" ? chunk : decoder.write(chunk); return consume(false); },
    end() { pending += decoder.end(); return consume(true); },
  };
}

export function maskLogText(text) {
  const masker = createLogMasker();
  return masker.write(text) + masker.end();
}

export function createLogMaskingStream() {
  const masker = createLogMasker();
  return new Transform({
    transform(chunk, _encoding, callback) { callback(null, masker.write(chunk)); },
    flush(callback) { callback(null, masker.end()); },
  });
}

let installed = false;
/** Intercept the final stdout/stderr write, covering console objects, stacks and raw writes. */
export function installLogMasking(env = process.env) {
  registerEnvironmentLogSecrets(env);
  if (installed) return;
  installed = true;
  const flushers = [process.stdout, process.stderr].map(stream => {
    const original = stream.write.bind(stream);
    const masker = createLogMasker();
    stream.write = (chunk, encoding, callback) => {
      const done = typeof encoding === "function" ? encoding : callback;
      const input = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : chunk;
      const text = masker.write(input);
      if (text) return original(text, done);
      if (done) process.nextTick(done);
      return true;
    };
    return () => { const tail = masker.end(); if (tail) original(tail); };
  });
  process.on("beforeExit", () => flushers.forEach(flush => flush()));
  process.on("exit", () => flushers.forEach(flush => flush()));
}
