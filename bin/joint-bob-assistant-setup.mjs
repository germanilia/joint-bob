#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const USAGE = 'Usage: node "$JOINT_BOB_ASSISTANT_SETUP_CLI" status | instructions FILE | skill FOLDER | login PROFILE_ID | secret --label LABEL --why TEXT NAME [NAME...]';
const WAIT_MS = 15 * 60_000;
const POLL_MS = 3_000;

async function call(body) {
  const endpoint = process.env.JOINT_BOB_ASSISTANT_SETUP_URL;
  const token = process.env.JOINT_BOB_ASSISTANT_SETUP_TOKEN;
  if (!endpoint || !token) throw new Error("This conversation is not setting up an assistant, or its setup has ended");
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Assistant setup request failed (${response.status})`);
  return result;
}

async function folderFiles(folder) {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push({ relativePath: path.relative(folder, full).split(path.sep).join("/"), data: (await readFile(full)).toString("base64") });
    }
  };
  await walk(folder);
  return files;
}

function secretArguments(args) {
  const names = [];
  let label, why;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--label") label = args[++index];
    else if (args[index] === "--why") why = args[++index];
    else names.push(args[index]);
  }
  if (!label || !why || !names.length) throw new Error(USAGE);
  return { label, why, names };
}

/** Waits for the person to fill the box, so the agent's turn goes on with the answer instead of ending. */
async function askSecret(input) {
  const asked = await call({ action: "secret", ...input });
  const deadline = Date.now() + WAIT_MS;
  let current = asked;
  while (current.status === "waiting" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    current = await call({ action: "secret-status", id: asked.id });
  }
  return current;
}

async function main(args) {
  const [command, ...rest] = args;
  let result;
  if (command === "status" && !rest.length) result = await call({ action: "status" });
  else if (command === "instructions" && rest.length === 1) result = await call({ action: "instructions", content: await readFile(rest[0], "utf8") });
  else if (command === "skill" && rest.length === 1) result = await call({ action: "skill", files: await folderFiles(path.resolve(rest[0])) });
  else if (command === "login" && rest.length === 1) result = await call({ action: "login", profileId: rest[0] });
  else if (command === "secret") result = await askSecret(secretArguments(rest));
  else throw new Error(USAGE);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
