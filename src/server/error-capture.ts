import { createRequire } from "node:module";
import type { NextFunction, Request, Response } from "express";
import { reportError } from "../error-reporting.js";

type RouteHandler = (request: Request, response: Response, next: NextFunction) => unknown;
interface ExpressLayer { handle: RouteHandler; handle_request(request: Request, response: Response, next: NextFunction): void }

/**
 * Express 4 drops a rejected async handler: the request hangs and the rejection
 * escapes as unhandled. Route every rejection to `next` so the error handler logs it.
 */
export function forwardAsyncRouteErrors(): void {
  const require = createRequire(import.meta.url);
  const Layer = require("express/lib/router/layer.js") as { prototype: ExpressLayer & { asyncErrorsForwarded?: boolean } };
  if (Layer.prototype.asyncErrorsForwarded) return;
  Layer.prototype.asyncErrorsForwarded = true;
  Layer.prototype.handle_request = function handleRequest(this: ExpressLayer, request, response, next) {
    const handler = this.handle;
    if (handler.length > 3) { next(); return; }
    try {
      const result = handler(request, response, next) as Promise<unknown> | undefined;
      if (result && typeof result.then === "function") result.then(undefined, (error: unknown) => next(error ?? new Error("Route handler rejected without a reason")));
    } catch (error) {
      next(error);
    }
  };
}

let forwarding = false;

function forward(values: unknown[]): void {
  if (forwarding) return;
  forwarding = true;
  try {
    // Structured console arguments may contain a request body or a transcript. Keep them in local logs only.
    const diagnostic = values.map((value) => value instanceof Error ? value.stack ?? value.message : typeof value === "string" ? value : "").filter(Boolean).join(" ");
    const [summary, ...detail] = (diagnostic || "Backend error (see local logs)").split("\n");
    void reportError("backend", { summary, detail: detail.join("\n") });
  } finally {
    forwarding = false;
  }
}

/** SQLite's SQLITE_BUSY, in any of its extended forms. */
export function databaseBusy(error: unknown): boolean {
  const { code, errcode } = (error ?? {}) as { code?: unknown; errcode?: unknown };
  return code === "ERR_SQLITE_ERROR" && typeof errcode === "number" && (errcode & 0xff) === 5;
}

let installed = false;

/** Mirrors console.error to the backend ntfy channel and keeps every unhandled failure in the log with its stack. */
export function installBackendErrorCapture(): void {
  if (installed) return;
  installed = true;
  const writeError = console.error.bind(console);
  console.error = (...values: unknown[]) => {
    writeError(...values);
    forward(values);
  };
  process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection", reason));
  process.on("uncaughtException", (error) => {
    // Another process held the database's write lock past the wait. The statement did not run
    // and nothing is left half-written, so the node stays up: exiting restarted it into a
    // start-up that made the next wait longer (three exits in fifteen minutes on the
    // homeserver, 2026-11-27, from a relay heartbeat and an agent's progress note).
    if (databaseBusy(error)) { console.error("Database write lock not obtained; the change was not saved", error); return; }
    writeError("Uncaught exception; the node is exiting", error);
    const [summary, ...detail] = `Uncaught exception; the node is exiting ${error.stack ?? error.message}`.split("\n");
    const exit = setTimeout(() => process.exit(1), 3_000);
    void reportError("backend", { summary, detail: detail.join("\n") }).finally(() => { clearTimeout(exit); process.exit(1); });
  });
}
