import { spawn } from "node:child_process";
import { setPriority } from "node:os";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import { createLogMaskingStream, registerEnvironmentLogSecrets, registerLogSecrets } from "./log-masking.mjs";

let command = null;

function logCommandOutput(child, combined) {
  if (!combined) return Promise.all([
    pipeline(child.stdout, createLogMaskingStream(), process.stdout, { end: false }),
    pipeline(child.stderr, createLogMaskingStream(), process.stderr, { end: false }),
  ]);
  // Both task descriptors share one file. Merge before masking so secrets cannot span them.
  const input = new PassThrough();
  const logged = pipeline(input, createLogMaskingStream(), process.stdout, { end: false });
  const copied = Promise.all([
    pipeline(child.stdout, createLogMaskingStream(), input, { end: false }),
    pipeline(child.stderr, createLogMaskingStream(), input, { end: false }),
  ]);
  copied.then(() => input.end(), error => input.destroy(error));
  return Promise.all([copied, logged]);
}

function send(message) {
  if (process.connected) process.send(message);
}

process.on("SIGTERM", () => {
  // The supervisor signals the whole group. Stay alive to retain group ownership.
});

process.on("disconnect", () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
});

process.on("message", message => {
  if (message.type !== "log-secrets") return;
  registerEnvironmentLogSecrets(message.env);
  send({ type: "log-secrets-registered", requestId: message.requestId });
});

process.once("message", message => {
  if (!message || message.type !== "launch") throw new Error("Invalid worker launch message");
  const { spec } = message;
  registerLogSecrets(message.logSecrets);
  registerEnvironmentLogSecrets(spec.env);
  // Set before spawning: commands and their descendants inherit the lower priority.
  // The lowest there is. At 10, a few dozen commands running at once (agents' test suites on a
  // four-core machine, 2026-11-10) still took a third of the CPU time the server asked for, and
  // every page waited. At 19 each of them weighs a seventh of that against the server, and they
  // share what is left among themselves exactly as before.
  if (message.background) setPriority(0, 19);
  command = spawn(spec.executable, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: false,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = logCommandOutput(command, message.background);
  output.catch(() => {
    send({ type: "exited", code: 1, signal: null, error: "Task log write failed" });
  });
  command.once("spawn", () => send({ type: "spawned", pid: command.pid }));
  command.once("error", error => send({ type: "spawn-error", error: error.message }));
  command.once("close", (code, signal) => {
    output.then(() => send({ type: "exited", code, signal }), () => {});
  });
});
