import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import claude from "../src/harnesses/claude.harness.ts";
import type { SessionProjectPaths } from "../src/session-paths.ts";

// The watcher asks this for every changed transcript and every project; the folders are worked out once per project.
test("a transcript belongs to the project whose working folder, or its parent, names its Claude folder", () => {
  const root = claude.sync.transcriptRoot!();
  const folder = (cwd: string) => path.join(root, cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-"));
  const project: SessionProjectPaths = { path: "/work/project", additionalPaths: ["/work/trees/a"] };
  const belongs = (file: string) => claude.sync.transcriptBelongs!(project, file);
  assert.equal(belongs(path.join(folder("/work/project"), "one.jsonl")), true);
  assert.equal(belongs(path.join(folder("/work/project"), "one", "subagents", "two.jsonl")), true);
  assert.equal(belongs(path.join(folder("/work"), "three.jsonl")), true, "the parent folder's conversations are listed too");
  assert.equal(belongs(path.join(folder("/work/trees/a"), "four.jsonl")), true);
  assert.equal(belongs(folder("/work/project")), true, "the folder itself");
  assert.equal(belongs(path.join(`${folder("/work/project")}-other`, "five.jsonl")), false, "a folder that only starts with the same name");
  assert.equal(belongs(path.join(folder("/work/trees/b"), "six.jsonl")), false);

  project.additionalPaths = ["/work/trees/b"];
  assert.equal(belongs(path.join(folder("/work/trees/b"), "six.jsonl")), true, "a replaced field is read again");
  assert.equal(belongs(path.join(folder("/work/trees/a"), "four.jsonl")), false);
});
