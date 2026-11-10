import { askSystemOneChoices, type SystemOneQuestion } from "./classifiers/typesafe.js";
import { decisionModelTarget } from "./classifiers/conversation-routing.js";
import { systemAiSettings } from "./system-ai-config.js";
import { systemDecisionKey } from "./system-ai.js";

/** What the page offers, described without any typed value. Indexes are positions in these lists. */
export interface LoginStepCandidates {
  title: string;
  headings: string[];
  inputs: Array<{ type: string; label: string; name: string; autocomplete: string }>;
  buttons: string[];
}
/** Positions in the candidate lists; a null field is one the sign-in step does not have. */
export interface LoginStepChoice { identity: number | null; password: number | null; button: number }
export type LoginStepChooser = (candidates: LoginStepCandidates) => Promise<LoginStepChoice | null>;

const MINIMUM_CONFIDENCE = 0.7;
const NOT_SIGN_IN = "None of the listed ones, or this page is not a sign-in step (for example search, sign-up, newsletter, settings or comments).";

/** Asks the decision model from Settings → System AI which listed elements are the sign-in step.
    The model only selects among elements the code listed; the caller still checks every element. */
export const chooseLoginStepWithSystemAi: LoginStepChooser = async candidates => {
  const model = systemAiSettings().decision.model;
  const selected = await decisionModelTarget(model, systemDecisionKey(model));
  if (!selected) throw new Error("System AI decision model is not available. Check Settings → System AI.");
  const options = (prefix: string, entries: Array<[number, string]>) => Object.fromEntries(entries.map(([index, text]) => [`${prefix}_${index}`, text]));
  const fields = candidates.inputs.map((input, index) => [index, input] as const);
  const describe = (input: LoginStepCandidates["inputs"][number]) => `Field labelled "${input.label}", name "${input.name}", autocomplete "${input.autocomplete}".`;
  const identities = fields.filter(([, input]) => input.type !== "password").map(([index, input]): [number, string] => [index, describe(input)]);
  const passwords = fields.filter(([, input]) => input.type === "password").map(([index, input]): [number, string] => [index, describe(input)]);
  const questions: Record<string, SystemOneQuestion> = {
    button: { instructions: "Which button submits this sign-in step (sign in, log in, continue or next)?", criteria: { none: NOT_SIGN_IN, ...options("button", candidates.buttons.map((text, index) => [index, `Button "${text}".`])) } },
    ...(identities.length ? { identity: { instructions: "Which field takes the username, email or account name used to sign in?", criteria: { none: NOT_SIGN_IN, ...options("input", identities) } } } : {}),
    ...(passwords.length ? { password: { instructions: "Which field takes the existing password used to sign in?", criteria: { none: NOT_SIGN_IN, ...options("input", passwords) } } } : {}),
  };
  const state = JSON.stringify({ page: candidates.title, headings: candidates.headings, fields: candidates.inputs, buttons: candidates.buttons });
  const answers = await askSystemOneChoices(selected.target, state.slice(0, selected.target.stateCharacters), questions, selected.apiKey);
  if (!answers) throw new Error("System AI decision model did not answer.");
  const index = (id: string) => {
    const answer = answers[id];
    return answer && answer.choice !== "none" && answer.confidence >= MINIMUM_CONFIDENCE ? Number(answer.choice.slice(answer.choice.indexOf("_") + 1)) : null;
  };
  const button = index("button"), identity = index("identity"), password = index("password");
  return button === null || (identity === null && password === null) ? null : { identity, password, button };
};
