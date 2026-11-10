import { spawn } from "node:child_process";
import { setPriority } from "node:os";

let command = null;

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

process.once("message", message => {
  if (!message || message.type !== "launch") throw new Error("Invalid worker launch message");
  const { spec } = message;
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
    stdio: ["ignore", 1, 2],
  });
  command.once("spawn", () => send({ type: "spawned", pid: command.pid }));
  command.once("error", error => send({ type: "spawn-error", error: error.message }));
  command.once("close", (code, signal) => send({ type: "exited", code, signal }));
});
