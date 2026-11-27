import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

// Every conversation list request touches its project; the write also re-sends the project's details to every peer.
test("touching a project writes only when it moves the project up, and at most once a minute", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-project-touch-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const { addProject, listProjects, touchProject, PROJECT_TOUCH_EVERY_MS } = await import("../src/store.js");
  const start = Date.now();
  mock.timers.enable({ apis: ["Date"], now: start });
  try {
    const first = await addProject("first", path.join(root, "first"));
    mock.timers.setTime(start + 1_000);
    const second = await addProject("second", path.join(root, "second"));
    const stamps = async () => Object.fromEntries((await listProjects()).map((project) => [project.id, project.updatedAt]));
    const created = await stamps();

    mock.timers.setTime(start + 10 * PROJECT_TOUCH_EVERY_MS);
    await touchProject(second.id);
    assert.deepEqual(await stamps(), created, "the project already first is not written");

    mock.timers.setTime(start + PROJECT_TOUCH_EVERY_MS / 2);
    await touchProject(first.id);
    assert.deepEqual(await stamps(), created, "one touched within the last minute waits");

    mock.timers.setTime(start + 10 * PROJECT_TOUCH_EVERY_MS);
    await touchProject(first.id);
    assert.equal((await listProjects())[0].id, first.id, "a project further down moves up");
    assert.equal((await stamps())[second.id], created[second.id]);
  } finally { mock.timers.reset(); await rm(root, { recursive: true, force: true }); }
});
