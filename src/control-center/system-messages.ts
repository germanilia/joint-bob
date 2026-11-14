import type { ProductionGuardStatus } from "../guardian/production-rule.js";

/**
 * Something the system itself found wrong: a missing key, a harness nobody signed in, a machine that does not answer.
 * They sit first in the control center's list, whatever else it shows, until the cause is gone; nobody can dismiss them.
 * `steps` and `why` are plain text; a `code` span is marked with backticks.
 */
export interface SystemMessage {
  id: string;
  /** "error": something does not work. "warn": it works, but not as it should. */
  severity: "error" | "warn";
  title: string;
  /** One line for the list. */
  short: string;
  /** Where the cause is, for the line under the title. */
  where: string;
  why: string;
  steps: string[];
  /** The button that goes to the fix: which screen it opens. */
  action: { label: string; open: "bob-settings" | "settings-guardian" | "settings-cluster" | "settings-harnesses" } | null;
}

/** What the server found out about itself; `systemMessages` turns it into messages, and nothing else decides what is shown. */
export interface SystemFacts {
  classifier: "typesafe" | "laya";
  /** Whether a decision model could be set up with the keys the projects have. */
  decisionModelReady: boolean;
  guardian: ProductionGuardStatus;
  /** Claude Code is installed here but reports that nobody is signed in. */
  claudeSignedOut: boolean;
  /** Machines of the person's own that do not answer, with how many of their conversations run there. */
  machinesAway: Array<{ id: string; name: string; conversations: number }>;
}

const GUARDIAN: Record<Exclude<ProductionGuardStatus, "on">, { title: string; why: string }> = {
  "guardian-off": { title: "Guardian is off", why: "With Guardian off, an agent can run a deploy or a delete without asking you first." },
  "rule-off": { title: "Guardian's production rule is off", why: "Guardian is on, but its rule for production and destructive steps is switched off, so those steps run without asking you." },
  "rule-missing": { title: "Guardian has no production rule", why: "Guardian is on, but it has no rule for production and destructive steps, so those steps run without asking you." },
};

export function systemMessages(facts: SystemFacts): SystemMessage[] {
  const messages: SystemMessage[] = [];
  if (facts.claudeSignedOut) {
    messages.push({
      id: "claude-signed-out", severity: "error", title: "Claude Code is not signed in on this machine", short: "Claude conversations cannot run here", where: "This machine",
      why: "Claude Code is installed, but nobody is signed in to it. A message to a Claude conversation here fails until someone signs in.",
      steps: ["Open a terminal on this machine and run `claude login`.", "Finish the sign-in in the browser it opens, or choose a subscription pool in `Settings → Harnesses`.", "Press Check again."],
      action: { label: "Open Settings → Harnesses", open: "settings-harnesses" },
    });
  }
  if (!facts.decisionModelReady) {
    const variable = facts.classifier === "typesafe" ? "TYPESAFE_AI_API_KEY" : "LAYA_API_KEY";
    const name = facts.classifier === "typesafe" ? "TypeSafe" : "Laya";
    messages.push({
      id: "decision-model", severity: "warn", title: "The decision model has no key", short: "Bob answers with his own agent, slower and less sure", where: "Bob's settings",
      why: `Bob uses ${name} to decide where a message goes. Without a key he falls back to his own agent: it works, but every message is slower and costs more.`,
      steps: [`Attach a secret named \`${variable}\` to one of your projects (\`Settings → Secrets\`).`, `Open \`Bob's settings → Decision model\` and check that ${name} is chosen.`, "Press Check again."],
      action: { label: "Open Bob's settings", open: "bob-settings" },
    });
  }
  if (facts.guardian !== "on") {
    const found = GUARDIAN[facts.guardian];
    messages.push({
      id: "guardian", severity: "warn", title: found.title, short: "Production and destructive steps are not checked", where: "Settings → Guardian",
      why: found.why,
      steps: ["Open `Settings → Guardian`.", "Turn Guardian on and turn on the rule `Production or destructive steps`.", "Press Check again."],
      action: { label: "Open Guardian settings", open: "settings-guardian" },
    });
  }
  for (const machine of facts.machinesAway) {
    const running = machine.conversations === 1 ? "1 conversation runs" : `${machine.conversations} conversations run`;
    messages.push({
      id: `machine-away:${machine.id}`, severity: "warn", title: `${machine.name} is offline`, short: machine.conversations ? `${running} there and cannot be reached` : "It does not answer", where: machine.name,
      why: "This machine does not answer. Its work is safe; it carries on when the machine is back.",
      steps: ["Check that the machine is on and online (`tailscale status` shows it, if you use Tailscale).", "On the machine, restart Joint Bob.", "Press Check again, or move its conversations to this machine from the control center."],
      action: { label: "Open Settings → Cluster", open: "settings-cluster" },
    });
  }
  return messages;
}
