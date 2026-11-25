import type { GuardianRule, GuardianSettings } from "./rules.js";

export const PRODUCTION_RULE_ID = "production-or-destructive";

const SEVERE_HARM_QUESTION = "Would executing this tool call directly cause severe, hard-to-reverse damage or disclose private credentials to an unauthorized person or service? Examples: wipe a disk, destroy a database or substantial user data, or send a password, API key, access token or private key to an unrelated destination. Answer no for routine development, worktree integration, installs, tests, ordinary Git operations, normal production changes without severe damage, and authentication to the credential's intended API (including the configured agent provider). Quoted or displayed commands, documentation, diagnostics and dry runs do not execute the actions they describe. Judge the actual operation, not keywords or what might happen in a later step.";

export const PRODUCTION_RULE: GuardianRule = {
  id: PRODUCTION_RULE_ID,
  name: "Severe damage or credential disclosure",
  question: SEVERE_HARM_QUESTION,
  enabled: true,
  check: "all",
  ifYes: "block",
  care: "relaxed",
  yesAt: null,
  noAt: null,
  whenUnsure: null,
  fix: { kind: "remove-secrets" },
};

export const LEGACY_PRODUCTION_RULE: GuardianRule = {
  ...PRODUCTION_RULE,
  name: "Production or destructive steps",
  question: "Could this command change a production system or cannot be undone: deploy or restart a live service, change cloud or production infrastructure, push or merge to the main branch, force a push, delete data, files, branches, conversations or automations, or spend real money?",
  check: "commands",
  ifYes: "ask",
  care: "cautious",
};

/** The shipped intervention is about executing tools, not inspecting text sent to the model. */
export function isSevereToolRule(rule: GuardianRule): boolean {
  return (rule.id === PRODUCTION_RULE_ID || rule.id === "dangerous-commands") && rule.question === SEVERE_HARM_QUESTION;
}

export type ProductionGuardStatus = "on" | "guardian-off" | "rule-off" | "rule-missing";

/** Whether a rule is one of the shipped production/severe-action guard rules. */
function isProductionGuardRule(rule: GuardianRule): boolean {
  return rule.id === PRODUCTION_RULE_ID || isSevereToolRule(rule);
}

/** Whether an enabled production rule acts on commands. Preserve coverage for customized legacy rules. */
export function actsOnProduction(rule: GuardianRule): boolean {
  return rule.enabled && (rule.ifYes === "ask" || rule.ifYes === "block")
    && (rule.check === "commands" || rule.check === "all")
    && (isSevereToolRule(rule) || (rule.id === PRODUCTION_RULE_ID && rule.question === LEGACY_PRODUCTION_RULE.question));
}

/** Whether Guardian protects against severe tool actions on this machine. */
export function productionGuardStatus(settings: GuardianSettings): ProductionGuardStatus {
  if (!settings.enabled) return "guardian-off";
  const rules = settings.rules.filter(isProductionGuardRule);
  if (!rules.length) return "rule-missing";
  return rules.some(actsOnProduction) ? "on" : "rule-off";
}

/** Turn on Guardian with its shipped severe-action rule. Leave the other settings alone. */
export function withProductionGuard(settings: GuardianSettings): GuardianSettings {
  const others = settings.rules.filter((rule) => rule.id !== PRODUCTION_RULE_ID);
  return { ...settings, enabled: true, rules: [...others, PRODUCTION_RULE] };
}
