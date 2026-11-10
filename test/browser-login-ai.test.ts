import test from "node:test";
import assert from "node:assert/strict";
import { chooseLoginStepWithSystemAi } from "../src/browser-login-ai.js";
import { saveSecretAccount } from "../src/secrets.js";
import { systemAiDefaults } from "../src/system-ai-config.js";
import { save, settingsDatabase } from "../src/settings-store.js";

const candidates = {
  title: "Acme", headings: ["Welcome back"],
  inputs: [{ type: "text", label: "Search", name: "q", autocomplete: "" }, { type: "text", label: "Email", name: "who", autocomplete: "" }, { type: "password", label: "Secret", name: "", autocomplete: "" }],
  buttons: ["Log in", "Help"],
};

test("System AI chooser asks the configured decision model and accepts only confident, listed answers", async t => {
  await assert.rejects(chooseLoginStepWithSystemAi(candidates), /TypeSafe/, "no configured key is an error, not a guess");
  const secret = await saveSecretAccount({ label: "login chooser", provider: "typesafe", variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "synthetic-chooser-key" }] });
  const config = systemAiDefaults(); config.decision.typesafeAccountId = secret.id; save(settingsDatabase(), "systemAI", JSON.stringify(config));
  const requests: any[] = [];
  let answers: Record<string, { choice: string; confidence: number }> = {};
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer synthetic-chooser-key");
    requests.push(JSON.parse(init.body as string));
    return Response.json({ answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, { type: "choice", ...answer }])) });
  }) as typeof fetch;

  answers = { button: { choice: "button_0", confidence: .95 }, identity: { choice: "input_1", confidence: .9 }, password: { choice: "input_2", confidence: .99 } };
  assert.deepEqual(await chooseLoginStepWithSystemAi(candidates), { identity: 1, password: 2, button: 0 });
  const questions = requests[0].questions;
  assert.deepEqual(Object.keys(questions.identity.criteria), ["none", "input_0", "input_1"], "password fields are never offered as the username");
  assert.deepEqual(Object.keys(questions.password.criteria), ["none", "input_2"]);
  assert.deepEqual(Object.keys(questions.button.criteria), ["none", "button_0", "button_1"]);

  answers.identity = { choice: "input_1", confidence: .5 };
  assert.deepEqual(await chooseLoginStepWithSystemAi(candidates), { identity: null, password: 2, button: 0 }, "an unsure field is left out");
  answers.password = { choice: "none", confidence: .99 };
  assert.equal(await chooseLoginStepWithSystemAi(candidates), null, "no field means no sign-in step");
  answers = { button: { choice: "none", confidence: .99 }, identity: { choice: "input_1", confidence: .9 }, password: { choice: "input_2", confidence: .99 } };
  assert.equal(await chooseLoginStepWithSystemAi(candidates), null, "no submit button means no sign-in step");
  answers.button = { choice: "button_7", confidence: .99 };
  await assert.rejects(chooseLoginStepWithSystemAi(candidates), /did not answer/, "an answer outside the list is refused");

  const usernameOnly = { ...candidates, inputs: candidates.inputs.slice(0, 2) };
  answers = { button: { choice: "button_0", confidence: .9 }, identity: { choice: "input_1", confidence: .9 } };
  assert.deepEqual(await chooseLoginStepWithSystemAi(usernameOnly), { identity: 1, password: null, button: 0 });
  assert.equal(requests.at(-1).questions.password, undefined);
});
