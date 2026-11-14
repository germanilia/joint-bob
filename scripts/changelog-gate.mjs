#!/usr/bin/env node
// Blocks a push to main until the commits being pushed are described in
// CHANGELOG.md under a bumped package.json version. The push is refused with
// instructions for the agent to write both files and commit them first.
import { execFileSync } from "node:child_process";

const [baseSha, localSha] = process.argv.slice(2);
const base = /^0+$/.test(baseSha) ? null : baseSha;
const headingPattern = /^##[ \t]+(\d+\.\d+\.\d+)/m;
const unreleasedPattern = /^##[ \t]+Unreleased[ \t]*$/m;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function fileAt(commit, file) {
  return git("show", `${commit}:${file}`);
}

function isNewerVersion(candidate, baseline) {
  const left = candidate.split(".").map(Number);
  const right = baseline.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

/** The version at the top of a changelog, and whether it lists anything. */
function latestRelease(changelog) {
  const heading = headingPattern.exec(changelog);
  if (!heading) return null;
  const body = changelog.slice(heading.index + heading[0].length);
  const next = headingPattern.exec(body);
  const section = next ? body.slice(0, next.index) : body;
  return { version: heading[1], described: /^[-*][ \t]+\S/m.test(section) };
}

function blockThePush(reason) {
  console.error(`\nChangelog gate: ${reason}`);
  console.error([
    "Before this push, update the release for the pushed commits, commit it, and push again:",
    "1. package.json: set `version` to the next semantic version. A breaking change bumps major, any new feature bumps minor, otherwise bump patch.",
    "2. CHANGELOG.md: replace the `## Unreleased` bullets with one `## <that version> — <release date>` section directly above the newest version section. Cover every commit in the push range with one short past-tense bullet per user-visible change (at most 12), written for someone using the app: no commit prefixes, file names or hashes. Leave out pure refactors, test-only changes and dependency bumps.",
    "Change nothing else.",
  ].join("\n"));
  console.error("Push blocked.\n");
  process.exit(1);
}

const changed = (base ? git("diff", "--name-only", base, localSha) : git("show", "--name-only", "--format=", localSha)).split("\n").filter(Boolean);
// Only shipped application code earns a release note; docs and tooling do not.
if (!changed.some((file) => /^(src|public|bin)\//.test(file))) process.exit(0);

const pushedVersion = JSON.parse(fileAt(localSha, "package.json")).version;
const baseVersion = base ? JSON.parse(fileAt(base, "package.json")).version : null;
if (baseVersion && !isNewerVersion(pushedVersion, baseVersion)) blockThePush(`package.json is still ${pushedVersion}; every deployment needs its own version.`);

const changelog = fileAt(localSha, "CHANGELOG.md");
if (unreleasedPattern.test(changelog)) blockThePush("CHANGELOG.md still has Unreleased commit entries that need review.");
const release = latestRelease(changelog);
if (!release) blockThePush("CHANGELOG.md has no version sections.");
if (release.version !== pushedVersion) blockThePush(`CHANGELOG.md documents ${release.version} but package.json says ${pushedVersion}.`);
if (!release.described) blockThePush(`CHANGELOG.md lists no changes under ${pushedVersion}.`);
