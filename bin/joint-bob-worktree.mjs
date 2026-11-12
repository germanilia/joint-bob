#!/usr/bin/env node
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";

const token = process.env.JOINT_BOB_WORKTREE_TOKEN;
const endpoint = process.env.JOINT_BOB_WORKTREE_URL;
// Set from the node's Git setting when the conversation's agent starts; 360 seconds if an older agent lacks it.
const timeoutSeconds = Number(process.env.JOINT_BOB_WORKTREE_TIMEOUT_SECONDS) || 360;
const usage = `Usage:
  list
  status --operation ID
  merge [--worktree ID] --title TITLE --check COMMAND [--operation ID]
  create --name NAME [--color COLOR] [--finish local|pr]
  start --worktree ID (--prompt TEXT | --prompt-stdin) [--title TITLE]
  pr [--worktree ID] --title TITLE [--body TEXT | --body-stdin] [--base BRANCH]
  delete --worktree ID`;
const text = { type: "string" };
const flag = { type: "boolean" };
const commands = {
  list: { options: {} },
  status: { options: { operation: text }, required: ["operation"] },
  merge: { options: { worktree: text, title: text, check: text, operation: text, "resolve-main": text }, required: ["title", "check"] },
  create: { options: { name: text, color: text, finish: text }, required: ["name"] },
  start: { options: { worktree: text, prompt: text, "prompt-stdin": flag, title: text }, required: ["worktree"], stdin: "prompt" },
  pr: { options: { worktree: text, title: text, body: text, "body-stdin": flag, base: text }, required: ["title"], stdin: "body" },
  delete: { options: { worktree: text }, required: ["worktree"] },
};

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

async function requestBody(operation, values) {
  const optional = (key, value) => value === undefined ? {} : { [key]: value };
  const command = commands[operation];
  if (command.stdin) {
    const fromStdin = values[`${command.stdin}-stdin`];
    if (fromStdin && values[command.stdin] !== undefined) throw new Error(`Use --${command.stdin} or --${command.stdin}-stdin, not both`);
    if (fromStdin) values[command.stdin] = await readStdin();
  }
  switch (operation) {
    case "list": return { operation };
    case "status": return { operation, operationId: values.operation };
    case "merge": return { operation, operationId: values.operation ?? randomUUID(), title: values.title, check: values.check, ...optional("resolutionTarget", values["resolve-main"]), ...optional("worktreeId", values.worktree) };
    case "create": return { operation, name: values.name, ...optional("color", values.color), ...optional("finish", values.finish) };
    case "start":
      if (!values.prompt) throw new Error("start needs --prompt TEXT or --prompt-stdin");
      return { operation, worktreeId: values.worktree, prompt: values.prompt, ...optional("title", values.title) };
    case "pr": return { operation, title: values.title, ...optional("worktreeId", values.worktree), ...optional("body", values.body), ...optional("base", values.base) };
    case "delete": return { operation, worktreeId: values.worktree };
  }
}

async function request(body) {
  if (!token || !endpoint) throw new Error("Worktree environment missing; run inside a Joint Bob conversation");
  let response;
  try {
    response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutSeconds * 1000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(body.operation === "merge" ? `Integration ${body.operationId} has an unknown outcome. Run status --operation ${body.operationId}; retry only with the same --operation ID and arguments.` : body.operation === "list" || body.operation === "status" ? "Worktree bridge unreachable or timed out" : "Worktree request failed or timed out; its outcome is unknown. Run list before retrying.");
  }
  let value;
  try { value = await response.json(); } catch { throw new Error(`Invalid response from the worktree bridge (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(`Worktree request failed (HTTP ${response.status}): ${typeof value?.error === "string" ? value.error : "invalid server response"}`);
  return value;
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  const command = Object.hasOwn(commands, operation ?? "") ? commands[operation] : undefined;
  if (!command) throw new Error(usage);
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: command.options });
  if (positionals.length || (command.required ?? []).some((key) => !values[key])) throw new Error(usage);
  console.log(JSON.stringify(await request(await requestBody(operation, values)), null, 2));
}

main().catch((error) => { const message = error instanceof Error ? error.message : "Worktree command failed"; console.error(token ? message.split(token).join("[redacted]") : message); process.exitCode = 1; });
