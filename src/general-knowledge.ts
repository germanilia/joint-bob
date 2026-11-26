import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InstructionFile } from "./agent-instructions.js";
import { type KnowledgeShelf, type KnowledgeSubject, readSubjectsIn } from "./project-knowledge.js";

/**
 * Joint Bob's general knowledge: rules learned from conversations that hold in every project, not just
 * the one they came from. They live in `general-knowledge/` of Joint Bob's source, so a lesson learned
 * on a machine holding that source ships with the next release, and every agent reads the installed copy.
 */
export const GENERAL_KNOWLEDGE_FOLDER = "general-knowledge";

/** The copy that shipped with the running app. */
const installedDirectory = fileURLToPath(new URL(`../${GENERAL_KNOWLEDGE_FOLDER}/`, import.meta.url));

/** As much of the index as agents read into a conversation. */
const INDEX_LINES = 200;

export function generalShelf(sourceRoot: string): KnowledgeShelf {
  return {
    directory: path.join(sourceRoot, GENERAL_KNOWLEDGE_FOLDER),
    title: "Joint Bob general knowledge",
    intro: "Rules agents learned in Joint Bob conversations that apply in every project. Read a subject's file when the task touches it.",
  };
}

/** The general rules this app shipped with. */
export function installedGeneralSubjects(): KnowledgeSubject[] {
  return readSubjectsIn(installedDirectory);
}

/** The shipped index, which the agent reads before it decides what to open; null when nothing has been learned yet. */
export function generalKnowledgeInstructionFile(directory = installedDirectory): InstructionFile | null {
  const indexFile = path.join(directory, "INDEX.md");
  if (!existsSync(indexFile)) return null;
  const index = readFileSync(indexFile, "utf8").split("\n").slice(0, INDEX_LINES).join("\n").trimEnd();
  if (!index) return null;
  return {
    path: indexFile,
    label: "Joint Bob general knowledge",
    content: `Rules that apply in every project are in \`${directory}\`. Open a subject's file when the task touches it. A project's own rules take precedence.\n\n${index}`,
  };
}
