import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { RelayChannelError } from "../src/relay/stream.js";
import { app } from "../src/server.js";

type ErrorHandler = (error: unknown, request: Request, response: Response, next: NextFunction) => void;

// routes/updates registers the application's final error handler last.
function finalErrorHandler(): ErrorHandler {
  const stack = (app as unknown as { _router: { stack: Array<{ handle: ErrorHandler }> } })._router.stack;
  return stack.filter((layer) => layer.handle.length === 4).at(-1)!.handle;
}

function failAfterResponseStarted(error: Error): { errors: unknown[][]; warnings: unknown[][]; ended: boolean } {
  const errors = mock.method(console, "error", () => undefined);
  const warnings = mock.method(console, "warn", () => undefined);
  let ended = false;
  const request = { method: "GET", path: "/api/cluster/v2/transcripts/file" } as Request;
  const response = { headersSent: true, end: () => { ended = true; } } as unknown as Response;
  try {
    finalErrorHandler()(error, request, response, () => undefined);
    return { errors: errors.mock.calls.map((call) => call.arguments), warnings: warnings.mock.calls.map((call) => call.arguments), ended };
  } finally {
    errors.mock.restore();
    warnings.mock.restore();
  }
}

test("a relay channel closing mid-response is a warning, not an error report", () => {
  const result = failAfterResponseStarted(new RelayChannelError("Relay channel closed"));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [["GET /api/cluster/v2/transcripts/file stopped: the requester's relay connection closed (Relay channel closed)"]]);
  assert.equal(result.ended, true);
});

test("other failures after the response started are still reported", () => {
  const failure = new Error("disk read failed");
  const result = failAfterResponseStarted(failure);
  assert.deepEqual(result.errors, [["%s %s failed after its response started", "GET", "/api/cluster/v2/transcripts/file", failure]]);
  assert.equal(result.ended, true);
});
