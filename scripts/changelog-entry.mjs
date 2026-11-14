#!/usr/bin/env node
// Reminds the agent making a commit to record one staged application change under
// the Unreleased changelog section. The pre-push gate later turns these entries into
// release notes for the full push range. This only prints; it never edits files.
import { execFileSync } from "node:child_process";

const changed = execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" }).split("\n").filter(Boolean);
if (!changed.some((file) => /^(src|public|bin)\//.test(file))) process.exit(0);

console.error([
  "pre-commit: this commit changes the application. Before committing, add one short past-tense bullet under `## Unreleased` in CHANGELOG.md describing its effect for the person using the app, then stage CHANGELOG.md.",
  "Do not use commit prefixes, file names or implementation detail.",
].join("\n"));
