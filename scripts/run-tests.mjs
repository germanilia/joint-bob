import { spawn } from "node:child_process";
import { acquireTestSlot } from "./test-slots.mjs";

// Test fixtures never need the attached production decision-service credential.
delete process.env.TYPESAFE_AI_API_KEY;
const env = { ...process.env };
delete env.TYPESAFE_AI_API_KEY;

// One machine runs only so many test runs at once; the others wait their turn (test-slots.mjs says why).
const release = await acquireTestSlot();
// A run that a test of this run starts must not wait for the slot this run holds.
env.JOINT_BOB_TEST_SLOT_HELD = "1";
const child = spawn(process.execPath, process.argv.slice(2), { cwd: process.cwd(), env, stdio: "inherit" });
// Whoever stops this wrapper means the run: without this the tests would go on, holding no slot.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { child.kill(signal); });
process.on("exit", release);
child.on("error", (error) => { release(); throw error; });
child.on("close", (code) => { release(); process.exitCode = code ?? 1; });
