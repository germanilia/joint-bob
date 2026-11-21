#!/usr/bin/env node
// Claude Code PreToolUse hook: asks Joint Bob's Guardian about the tool call on stdin and prints
// Claude's permission decision. Anything that goes wrong denies the call; it never lets one through.
import http from "node:http";
import https from "node:https";

function decide(permissionDecision, extra) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, ...extra } }));
}

const ATTEMPTS = 30;
const RETRY_EVERY_MS = 1_000;

// A review waits for the person for up to ten minutes. Node's fetch gives up after five, which blocked the
// call early and made the server record it as denied, so this uses a plain request that waits as long as the server does.
function post(body) {
  const url = new URL(process.env.JOINT_BOB_GUARDIAN_URL);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.JOINT_BOB_GUARDIAN_TOKEN}`, "content-type": "application/json" },
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}

// Joint Bob restarts for updates and deploys. A refused connection means "not up yet", so wait for it instead of
// blocking every tool call. Only a server that stays away for all attempts denies the call.
async function askJointBob(body) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await post(body);
    } catch (error) {
      if (attempt >= ATTEMPTS) throw new Error(`Joint Bob did not answer after ${ATTEMPTS} attempts (${error.message}).`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_EVERY_MS));
    }
  }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  const response = await askJointBob(JSON.stringify({ tool: event.tool_name, input: event.tool_input ?? {} }));
  let parsed = null;
  try { parsed = JSON.parse(response.text); } catch { /* not JSON: reported below */ }
  if (response.status !== 200 || !parsed?.verdict) throw new Error(parsed?.error || `Joint Bob answered HTTP ${response.status}`);
  const verdict = parsed.verdict;
  if (verdict.action === "block") decide("deny", { permissionDecisionReason: verdict.reason });
  else if (verdict.action === "replace") decide("allow", { permissionDecisionReason: "Guardian changed this call's arguments.", updatedInput: verdict.input });
}

main().catch((error) => decide("deny", { permissionDecisionReason: `Guardian could not check this tool call, so it was blocked. ${error.message}` }));
