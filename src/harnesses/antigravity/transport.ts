import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

type RecordValue = Record<string, unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type NotificationHandler = (method: string, params: unknown) => void;
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Antigravity ACP JSON-RPC envelope");
  const result = value as RecordValue;
  if (result.jsonrpc !== "2.0") throw new Error("Invalid Antigravity ACP JSON-RPC version");
  return result;
}

function rpcError(value: unknown): Error {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Antigravity ACP JSON-RPC error");
  const error = value as RecordValue;
  if (typeof error.code !== "number" || typeof error.message !== "string") throw new Error("Invalid Antigravity ACP JSON-RPC error");
  const detail = typeof error.data === "string" && error.data.trim() ? `: ${error.data.trim()}` : "";
  return new Error(`ACP error ${error.code}: ${error.message}${detail}`);
}

class AntigravityConnection {
  private buffer = "";
  private stderr = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private nextId = 1;
  private failure: Error | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly resolveClosed: () => void;
  readonly closed: Promise<void>;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly onNotification: NotificationHandler, private readonly onRequest: RequestHandler) {
    let resolveClosed!: () => void;
    this.closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    this.resolveClosed = resolveClosed;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + this.stderrDecoder.write(chunk)).slice(-2000); });
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => { this.fail(error); this.resolveClosed(); });
    child.on("close", (code, signal) => { this.fail(this.exitError(code, signal)); this.resolveClosed(); });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.fail(error); }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.failure) throw this.failure;
    try { this.write({ jsonrpc: "2.0", method, params }); }
    catch (error) { this.fail(error); throw this.failure; }
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.buffer += this.stdoutDecoder.write(chunk);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this.dispatch(record(JSON.parse(line) as unknown)); }
      catch (error) { this.fail(error); return; }
    }
  }

  private dispatch(value: RecordValue): void {
    if (Object.hasOwn(value, "method")) {
      if (typeof value.method !== "string" || Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) throw new Error("Invalid Antigravity ACP method message");
      if (Object.hasOwn(value, "id")) this.handleServerRequest(value);
      else this.onNotification(value.method, value.params);
      return;
    }
    const hasResult = Object.hasOwn(value, "result"), hasError = Object.hasOwn(value, "error");
    if (typeof value.id !== "number" || hasResult === hasError) throw new Error("Invalid Antigravity ACP reply");
    const pending = this.pending.get(value.id);
    if (!pending) throw new Error(`Uncorrelatable Antigravity ACP reply ID: ${value.id}`);
    const error = hasError ? rpcError(value.error) : undefined;
    this.pending.delete(value.id);
    if (error) pending.reject(error);
    else pending.resolve(value.result);
  }

  private handleServerRequest(value: RecordValue): void {
    if ((typeof value.id !== "number" && typeof value.id !== "string") || value.id === "") throw new Error("Invalid Antigravity ACP request ID");
    const id = value.id;
    void this.onRequest(value.method as string, value.params).then(
      (result) => this.respond({ jsonrpc: "2.0", id, result }),
      (error) => this.respond({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }),
    );
  }

  private respond(value: RecordValue): void {
    if (this.failure) return;
    try { this.write(value); } catch (error) { this.fail(error); }
  }

  private write(value: RecordValue): void { this.child.stdin.write(`${JSON.stringify(value)}\n`); }

  private exitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const status = code === null ? `signal ${signal}` : `code ${code}`;
    return new Error(`Antigravity ACP process exited with ${status}${this.stderr ? `\n${this.stderr}` : ""}`);
  }

  private fail(reason: unknown): void {
    if (this.failure) return;
    this.failure = reason instanceof Error ? reason : new Error(String(reason));
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
    if (this.child.exitCode === null && this.child.signalCode === null && !this.child.killed) this.child.kill();
  }
}

export function createAntigravityConnection(child: ChildProcessWithoutNullStreams, onNotification: NotificationHandler, onRequest: RequestHandler) {
  const connection = new AntigravityConnection(child, onNotification, onRequest);
  return { request: (method: string, params: unknown) => connection.request(method, params), notify: (method: string, params: unknown) => connection.notify(method, params), closed: connection.closed };
}
