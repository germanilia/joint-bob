import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSettings, updateSettings } from "../src/settings.js";
import { AntigravityLogins } from "../src/harnesses/antigravity/login.js";

const fixture = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const assert=require('node:assert/strict');
assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS,undefined);
const args=process.argv.slice(2);
if(args.includes('--login')){
 assert.deepEqual(args,['acp','--login']);
 assert.equal(process.env.BROWSER,'true');
 process.stdout.write('Open this link: https://evil.example/?token=private\\n');
 process.stdout.write('https://accounts.google.com/o/oauth2/auth?client_id=fixture&state=fixture\\n');
 process.stdout.write('Then paste the authorization code, or the full URL of the page you land on, and press Enter:\\n');
 readline.createInterface({input:process.stdin}).on('line',code=>{
  if(code==='good-code'){fs.writeFileSync(path.join(process.env.HOME,'signed-in'),'fixture');if(process.env.AGY_FIXTURE_HOME_RECORD)fs.writeFileSync(process.env.AGY_FIXTURE_HOME_RECORD,process.env.HOME);process.exit(0);}
  process.stderr.write('private submitted value: '+code);process.exit(1);
 });
}else{
 readline.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);
  const result=r.method==='initialize'?{protocolVersion:1}:{sessionId:'check',configOptions:[]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
 }).on('close',()=>process.exit(0));
}
`;

async function waitFor(check: () => boolean) {
  const end = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Sign-in fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("native Google sign-in captures only Google URLs, accepts codes privately, verifies completion and supports cancellation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-login-test-")), previous = getSettings();
  const logins = new AntigravityLogins();
  try {
    const executable = path.join(root, "agy");
    await writeFile(executable, fixture); await chmod(executable, 0o700);
    updateSettings({ runtimes: { ...previous.runtimes, antigravity: { executable, configPath: path.join(root, ".gemini"), sessionPath: path.join(root, "sessions") } } });
    await logins.start("owner");
    await assert.rejects(logins.start("other"), /already in progress/);
    assert.equal(logins.status("other"), undefined);
    await waitFor(() => Boolean(logins.status("owner")?.prompt));
    assert.match(logins.status("owner")!.url!, /^https:\/\/accounts.google.com\//);
    assert.doesNotMatch(JSON.stringify(logins.status("owner")), /evil|private/);
    assert.throws(() => logins.answer("other", "good-code"), /No pending/);
    assert.throws(() => logins.answer("owner", "one\ntwo"), /single line/);
    logins.answer("owner", "good-code");
    await waitFor(() => logins.status("owner")?.state === "complete");
    assert.doesNotMatch(JSON.stringify(logins.status("owner")), /good-code|state=fixture/);
    await logins.start("owner");
    await waitFor(() => Boolean(logins.status("owner")?.prompt));
    logins.answer("owner", "wrong-private-code");
    await waitFor(() => logins.status("owner")?.state === "failed");
    assert.doesNotMatch(JSON.stringify(logins.status("owner")), /wrong-private-code/);
    await logins.start("owner");
    await logins.cancel("owner");
    assert.equal(logins.status("owner")?.state, "cancelled");
  } finally {
    if (logins.status("owner")?.state === "waiting") await logins.cancel("owner");
    updateSettings({ runtimes: previous.runtimes });
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity profile sign-in uses a separate CLI home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-profile-login-test-")), previous = getSettings();
  const previousHomeRecord = process.env.AGY_FIXTURE_HOME_RECORD;
  const logins = new AntigravityLogins();
  const profile = { id: "00000000-0000-4000-8000-000000000010", owner: "owner", label: "Work", provider: "antigravity", createdAt: new Date().toISOString(), shared: false } as const;
  try {
    const executable = path.join(root, "agy");
    await writeFile(executable, fixture); await chmod(executable, 0o700);
    updateSettings({ runtimes: { ...previous.runtimes, antigravity: { executable, configPath: path.join(root, ".gemini"), sessionPath: path.join(root, "sessions") } } });
    const homeRecord = path.join(root, "profile-home");
    process.env.AGY_FIXTURE_HOME_RECORD = homeRecord;
    await logins.start("owner", profile);
    await waitFor(() => Boolean(logins.status("owner", profile)?.prompt));
    logins.answer("owner", "good-code", profile);
    await waitFor(() => logins.status("owner", profile)?.state === "complete");
    assert.notEqual(await readFile(homeRecord, "utf8"), path.dirname(path.join(root, ".gemini")));
    assert.doesNotMatch(JSON.stringify(logins.status("owner", profile)), /good-code/);
  } finally {
    if (logins.status("owner", profile)?.state === "waiting") await logins.cancel("owner", profile);
    if (previousHomeRecord === undefined) delete process.env.AGY_FIXTURE_HOME_RECORD;
    else process.env.AGY_FIXTURE_HOME_RECORD = previousHomeRecord;
    updateSettings({ runtimes: previous.runtimes });
    await rm(root, { recursive: true, force: true });
  }
});
