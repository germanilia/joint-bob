import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { reservedMcpServerMessage, reservedMcpServerName } from "../assistant-collaboration/bridge-tools.js";

const secureUrl = z.string().url().max(4096).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}, "Use HTTPS, or HTTP on localhost, without credentials or a fragment");
const serverSchema = z.object({
  authMode: z.enum(["shared", "native"]).optional(),
  type: z.enum(["stdio", "http", "streamable-http"]).optional(),
  command: z.string().min(1).max(4096).optional(), args: z.array(z.string().max(8192)).max(100).optional(),
  env: z.record(z.string().max(8192)).optional(), cwd: z.string().max(4096).optional(),
  url: secureUrl.optional(), headers: z.record(z.string().max(8192)).optional(),
  oauth: z.object({ clientId: z.string().min(1), clientSecret: z.string().optional() }).strict().optional(),
}).strict().superRefine((server, ctx) => {
  const stdio = Boolean(server.command), http = Boolean(server.url);
  if (stdio === http || stdio && server.type && server.type !== "stdio" || http && server.type === "stdio") ctx.addIssue({ code: "custom", message: "Specify one command or HTTP URL matching the transport" });
  if (stdio && (server.headers || server.oauth) || http && (server.args || server.env || server.cwd)) ctx.addIssue({ code: "custom", message: "Options do not match the transport" });
});
export type ManagedMcpServer = z.infer<typeof serverSchema>;
const configSchema = z.object({ mcpServers: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), serverSchema).refine(servers => Object.keys(servers).length > 0 && Object.keys(servers).length <= 100, "Choose 1 to 100 servers") }).strict();
export function parseMcpServers(value: unknown): Record<string, ManagedMcpServer> { return configSchema.parse(value).mcpServers; }
export interface McpAuthData { tokens?: OAuthTokens; client?: OAuthClientInformationMixed; verifier?: string; redirectUrl?: string }

function readJson<T>(file: string, absent: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent; throw error; }
}
function saveJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}

/** Node-local, service-owned files. Neither definitions nor OAuth state enter replicated resources. */
export class ManagedMcpStore {
  readonly directory: string;
  constructor(root: string, accountId: string) {
    if (!accountId) throw new Error("MCP requires an account");
    this.directory = path.join(root, "mcp", createHash("sha256").update(accountId).digest("hex"));
  }
  servers(): Record<string, ManagedMcpServer> { return readJson(path.join(this.directory, "servers.json"), {}); }
  private digest(server: ManagedMcpServer): string { return createHash("sha256").update(JSON.stringify(server)).digest("hex"); }
  /** Grants contain no credentials or definition. A changed definition cannot inherit a grant. */
  shares(): Record<string, Record<string, string>> { return readJson(path.join(this.directory, "team-shares.json"), {}); }
  sharedWith(name: string, teamId: string): boolean {
    const server = this.servers()[name];
    return !!server && this.shares()[teamId]?.[name] === this.digest(server);
  }
  setTeamShare(name: string, teamId: string, enabled: boolean): void {
    const server = this.servers()[name];
    if (!server || server.authMode === "native") throw new Error("Only installed shared-connection MCP servers can be shared with a team");
    const shares = this.shares();
    const entries = { ...shares[teamId] };
    if (enabled) entries[name] = this.digest(server); else delete entries[name];
    if (Object.keys(entries).length) shares[teamId] = entries; else delete shares[teamId];
    saveJson(path.join(this.directory, "team-shares.json"), shares);
  }
  install(servers: Record<string, ManagedMcpServer>): void {
    const current = this.servers();
    for (const name of Object.keys(servers)) if (Object.hasOwn(current, name)) throw new Error(`MCP server ${name} is already installed`);
    const reserved = Object.keys(servers).find(reservedMcpServerName);
    if (reserved !== undefined) throw new Error(reservedMcpServerMessage(reserved));
    const names = [...Object.keys(current), ...Object.keys(servers)].map(name => name.replaceAll("-", "_"));
    if (new Set(names).size !== names.length) throw new Error("MCP server names must not differ only by hyphens and underscores");
    saveJson(path.join(this.directory, "servers.json"), { ...current, ...servers });
  }
  remove(name: string): void {
    const servers = this.servers();
    if (!Object.hasOwn(servers, name)) throw new Error("MCP server not found");
    delete servers[name];
    const shares = this.shares();
    for (const [teamId, entries] of Object.entries(shares)) {
      delete entries[name];
      if (!Object.keys(entries).length) delete shares[teamId];
    }
    saveJson(path.join(this.directory, "team-shares.json"), shares);
    saveJson(path.join(this.directory, "servers.json"), servers);
    this.clearAuth(name);
  }
  private authFile(name: string): string { return path.join(this.directory, `auth-${createHash("sha256").update(name).digest("hex")}.json`); }
  readAuth(name: string): McpAuthData { return readJson(this.authFile(name), {}); }
  writeAuth(name: string, value: McpAuthData): void { saveJson(this.authFile(name), value); }
  clearAuth(name: string): void { rmSync(this.authFile(name), { force: true }); }
}
