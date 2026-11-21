#!/usr/bin/env node
// Claude Code PreToolUse hook: asks Joint Bob's Guardian about the tool call on stdin and prints
// Claude's permission decision. Anything that goes wrong denies the call; it never lets one through.

function decide(permissionDecision, extra) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, ...extra } }));
}

const RETRY_FOR_MS = 30_000;
const RETRY_EVERY_MS = 1_000;

// Joint Bob restarts for updates and deploys. A refused connection means "not up yet", so wait for it instead of
// blocking every tool call. Only a server that stays away for the whole wait denies the call.
async function askJointBob(body) {
  const giveUpAt = Date.now() + RETRY_FOR_MS;
  for (;;) {
    try {
      return await fetch(process.env.JOINT_BOB_GUARDIAN_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.JOINT_BOB_GUARDIAN_TOKEN}`, "content-type": "application/json" },
        body,
      });
    } catch (error) {
      if (Date.now() >= giveUpAt) throw new Error(`Joint Bob did not answer for ${RETRY_FOR_MS / 1000} seconds (${error.message}).`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_EVERY_MS));
    }
  }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  const response = await askJointBob(JSON.stringify({ tool: event.tool_name, input: event.tool_input ?? {} }));
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.verdict) throw new Error(body?.error || `Joint Bob answered HTTP ${response.status}`);
  const verdict = body.verdict;
  if (verdict.action === "block") decide("deny", { permissionDecisionReason: verdict.reason });
  else if (verdict.action === "replace") decide("allow", { permissionDecisionReason: "Guardian changed this call's arguments.", updatedInput: verdict.input });
}

main().catch((error) => decide("deny", { permissionDecisionReason: `Guardian could not check this tool call, so it was blocked. ${error.message}` }));
