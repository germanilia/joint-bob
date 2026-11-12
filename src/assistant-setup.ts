import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { assistantIdForConversation } from "./assistant-resources.js";
import { settingsDatabase } from "./settings-store.js";

// An assistant Bob creates sets itself up in its first conversation: it researches how its job is done, gets what it needs
// from the person, and gives itself a skill and instructions. While that setup is open, and only then, its agent has a setup
// tool that changes the assistant. Afterwards an assistant's agent cannot rewrite its own skill or instructions, so nothing it
// reads later can make it change itself.

/** A setup left open this long is over: the tool stops working. */
export const ASSISTANT_SETUP_MAX_MS = 24 * 60 * 60 * 1000;

export interface AssistantSetup { assistantId: string; accountId: string; purpose: string; startedAt: string; finishedAt: string | null }
export type SetupSecretStatus = "waiting" | "saved" | "declined";
export interface SetupSecretRequest { id: string; assistantId: string; accountId: string; label: string; names: string[]; why: string; status: SetupSecretStatus; createdAt: string }

function ensure(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_setups (
      assistant_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, purpose TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE IF NOT EXISTS assistant_setup_tokens (token_hash TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_setup_secrets (
      id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, account_id TEXT NOT NULL, label TEXT NOT NULL, names TEXT NOT NULL, why TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL)`);
}

function database(): DatabaseSync {
  const db = settingsDatabase();
  ensure(db);
  return db;
}

export function beginAssistantSetup(assistantId: string, accountId: string, purpose: string): void {
  database().prepare(`INSERT INTO assistant_setups (assistant_id, account_id, purpose, started_at, finished_at) VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(assistant_id) DO UPDATE SET purpose = excluded.purpose, started_at = excluded.started_at, finished_at = NULL`)
    .run(assistantId, accountId, purpose, new Date().toISOString());
}

/** The assistant's setup while it is open; undefined once it is finished, too old, or was never started. */
export function openAssistantSetup(assistantId: string, now = Date.now()): AssistantSetup | undefined {
  const row = database().prepare("SELECT assistant_id assistantId, account_id accountId, purpose, started_at startedAt, finished_at finishedAt FROM assistant_setups WHERE assistant_id = ?").get(assistantId) as AssistantSetup | undefined;
  return row && !row.finishedAt && now - Date.parse(row.startedAt) < ASSISTANT_SETUP_MAX_MS ? row : undefined;
}

/** Ends the setup: the agent's setup tool stops working, and requests still waiting for the person are dropped. */
export function finishAssistantSetup(assistantId: string): boolean {
  const db = database();
  const changed = db.prepare("UPDATE assistant_setups SET finished_at = ? WHERE assistant_id = ? AND finished_at IS NULL").run(new Date().toISOString(), assistantId).changes;
  db.prepare("DELETE FROM assistant_setup_tokens WHERE assistant_id = ?").run(assistantId);
  db.prepare("UPDATE assistant_setup_secrets SET status = 'declined' WHERE assistant_id = ? AND status = 'waiting'").run(assistantId);
  return Boolean(changed);
}

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The setup tool for the agent of an assistant whose setup is open; nothing for any other conversation. */
export function assistantSetupAgentEnvironment(projectId: string, conversationId: string): NodeJS.ProcessEnv {
  const assistantId = assistantIdForConversation(projectId, conversationId);
  if (!assistantId || !openAssistantSetup(assistantId)) return {};
  const db = database();
  db.prepare("DELETE FROM assistant_setup_tokens WHERE expires_at <= ?").run(Date.now());
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO assistant_setup_tokens VALUES (?, ?, ?)").run(tokenHash(token), assistantId, Date.now() + ASSISTANT_SETUP_MAX_MS);
  return {
    JOINT_BOB_ASSISTANT_SETUP_CLI: fileURLToPath(new URL("../bin/joint-bob-assistant-setup.mjs", import.meta.url)),
    JOINT_BOB_ASSISTANT_SETUP_URL: `http://127.0.0.1:${process.env.PORT || 8790}/api/assistant-agent/setup`,
    JOINT_BOB_ASSISTANT_SETUP_TOKEN: token,
  };
}

/** The assistant a setup token speaks for, while its setup is open. */
export function assistantSetupAgentAssistant(token: string): string | undefined {
  if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
  const row = database().prepare("SELECT assistant_id id FROM assistant_setup_tokens WHERE token_hash = ? AND expires_at > ?").get(tokenHash(token), Date.now()) as { id: string } | undefined;
  return row && openAssistantSetup(row.id) ? row.id : undefined;
}

const secretOf = (row: Omit<SetupSecretRequest, "names"> & { names: string }): SetupSecretRequest => ({ ...row, names: JSON.parse(row.names) as string[] });
const SECRET_COLUMNS = "id, assistant_id assistantId, account_id accountId, label, names, why, status, created_at createdAt";

export function requestSetupSecret(assistantId: string, accountId: string, input: { label: string; names: string[]; why: string }): SetupSecretRequest {
  const id = randomUUID();
  database().prepare("INSERT INTO assistant_setup_secrets (id, assistant_id, account_id, label, names, why, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)")
    .run(id, assistantId, accountId, input.label, JSON.stringify(input.names), input.why, new Date().toISOString());
  return getSetupSecret(id)!;
}

export function getSetupSecret(id: string): SetupSecretRequest | undefined {
  const row = database().prepare(`SELECT ${SECRET_COLUMNS} FROM assistant_setup_secrets WHERE id = ?`).get(id) as (Omit<SetupSecretRequest, "names"> & { names: string }) | undefined;
  return row ? secretOf(row) : undefined;
}

/** Settles a request that still waits; false when the person already answered it. */
export function settleSetupSecret(id: string, status: Exclude<SetupSecretStatus, "waiting">): boolean {
  return Boolean(database().prepare("UPDATE assistant_setup_secrets SET status = ? WHERE id = ? AND status = 'waiting'").run(status, id).changes);
}

export const assistantSetupAgentInstructions = `# Assistant setup

Only a conversation whose first message says it sets up an assistant has this tool, and only while that setup is open. It changes the assistant with node "$JOINT_BOB_ASSISTANT_SETUP_CLI":

- status: the assistant's name, what it is for, and what it has so far.
- instructions FILE: saves the assistant's standing instructions from a Markdown file. They are told to every later conversation of the assistant.
- skill FOLDER: installs a skill folder (SKILL.md first, plus any scripts) as a skill only this assistant has. Installing a folder with the same skill name again replaces it.
- login PROFILE_ID: attaches a browser profile this conversation started, so every later conversation of the assistant is signed in with it.
- secret --label LABEL --why TEXT NAME [NAME...]: asks the person for secret values by variable name. They get a box to paste them into; the values go to Secrets, attached to this assistant, and you never see them. The command waits up to 15 minutes and prints saved, declined or waiting. After saved, use the variables through the secret CLI.

Never ask the person for a password, key or code in chat, and never print a secret value. Do not read or print the capability token. The tool stops working when the setup ends.`;

/** What the assistant's first conversation is told: how to set itself up for the job the person described. */
export function assistantSetupBrief(name: string, purpose: string): string {
  return [
    `Set yourself up as my assistant "${name}". What I want it for:\n${purpose.trim()}`,
    "This is the assistant's first conversation, and its setup. When you finish, every later conversation of this assistant must be able to do the job from its instructions and its skill alone, without this conversation.",
    [
      "1. Research how the job is really done today: read the service's current official documentation and terms on the web. Compare the routes (an official API, an MCP server or command-line tool already on this machine, or the website in a browser signed in as me) and choose the one that works for my own account with the least setup from me. An API that needs a developer app, a review or a paid plan is usually the wrong choice when the website does the job. Say which route you chose and why.",
      '2. Get what it needs from me, and nothing more. For a website sign-in, start a named profile with the browser CLI at the sign-in page (start URL --name "LABEL"); the sign-in card appears for me by itself, so wait for me inside your turn by checking status every 20 seconds for up to 10 minutes, then attach the profile with the setup CLI (login PROFILE_ID). For a key or token, ask with the setup CLI (secret --label ... --why "what it is and exactly where I get it" NAME); it waits for me. Never ask for a password, key or code in chat.',
      "3. Prove the route works without doing anything other people can see: no posting, sending, publishing, buying or deleting during setup. Go as far as the last step before that (for example open the composer, fill it, then discard it), and read something back that shows you act as me.",
      "4. Write the assistant's skill: a folder with SKILL.md (front matter with name and description, then the exact steps that worked: addresses, selectors or API calls, how to check it succeeded, what to do when signed out, limits, and what needs my OK first) plus any scripts it needs. Install it with the setup CLI (skill FOLDER).",
      "5. Write the assistant's standing instructions (who it is, what it does, and that it asks me before anything public or irreversible) to a file and save them with the setup CLI (instructions FILE).",
      "6. End with a report: the route and why, what I gave it (sign-ins and secret names, never values), what the skill contains, what you tested and what you could not test, and one example of what I can now ask it.",
    ].join("\n"),
  ].join("\n\n");
}
