import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { sessionCwds, sessionCwdSet, type SessionProjectPaths } from "../src/harnesses/shared-paths.ts";

// A listing asks for a project's folders once per transcript; they are worked out once per project object.
test("a project's folders are kept with the project object and made again when a field is replaced", () => {
  const project: SessionProjectPaths = { path: "/work/project", macPath: "/Users/me/project", locations: [{ nodeId: "n", path: "/srv/project" }] as SessionProjectPaths["locations"], additionalPaths: ["/work/worktrees/a", "/work/project"] };
  const expected = ["/work/project", "/Users/me/project", "/srv/project", "/work/worktrees/a"].map((cwd) => path.resolve(cwd));
  assert.deepEqual(sessionCwds(project), expected);
  assert.equal(sessionCwdSet(project), sessionCwdSet(project), "the set is made once");
  assert.deepEqual([...sessionCwdSet(project)], expected);

  const mine = sessionCwds(project);
  mine.push("/elsewhere"); mine.sort();
  assert.deepEqual(sessionCwds(project), expected, "a caller's changes to its list stay its own");

  project.additionalPaths = ["/work/worktrees/b"];
  assert.deepEqual(sessionCwds(project), ["/work/project", "/Users/me/project", "/srv/project", "/work/worktrees/b"].map((cwd) => path.resolve(cwd)));
  assert.ok(sessionCwdSet(project).has(path.resolve("/work/worktrees/b")) && !sessionCwdSet(project).has(path.resolve("/work/worktrees/a")));
  project.path = "/work/moved";
  assert.equal(sessionCwds(project)[0], path.resolve("/work/moved"));
  assert.deepEqual(sessionCwds({ ...project }), sessionCwds(project), "a copy of the project gives the same folders");
});
