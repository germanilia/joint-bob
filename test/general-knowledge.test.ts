import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generalKnowledgeInstructionFile, generalShelf } from "../src/general-knowledge.js";
import { addRuleIn } from "../src/project-knowledge.js";

test("general lessons are subject files in general-knowledge/ whose index every agent reads", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "general-knowledge-"));
  try {
    const shelf = generalShelf(source);
    assert.equal(shelf.directory, path.join(source, "general-knowledge"));
    assert.equal(generalKnowledgeInstructionFile(shelf.directory), null, "nothing learned yet adds nothing");
    addRuleIn(shelf, { subject: "verification", text: "Run the check before saying it passed.", evidence: "Claimed a pass without running it" });
    const file = generalKnowledgeInstructionFile(shelf.directory);
    assert.equal(file?.label, "Joint Bob general knowledge");
    assert.match(file!.content, /A project's own rules take precedence/);
    assert.match(file!.content, /- \[verification\]\(verification\.md\) — verification \(1 rule\)/);
  } finally { await rm(source, { recursive: true, force: true }); }
});
