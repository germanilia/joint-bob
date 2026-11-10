import { randomUUID } from "node:crypto";
import type { JSHandle, Page } from "playwright-core";
import { browserLoginDetectionScript } from "./browser-login-detection.js";
import type { LoginStepCandidates, LoginStepChooser } from "./browser-login-ai.js";

interface BoundForm {
  origin: string;
  url: string;
  fields: HTMLInputElement[];
  button: HTMLElement;
  /** Null when the chosen fields and button do not share one form; then there is no form action to check. */
  root: HTMLFormElement | null;
  action: string | null;
  types: string[];
  observed: string | null;
  observe: () => string | null;
}
interface Candidates { inputs: HTMLInputElement[]; buttons: HTMLElement[]; described: LoginStepCandidates; observe: () => string | null }
const steps = new WeakMap<Page, { id: string; requestId: string; handle: JSHandle<BoundForm | null> }>();

// The card reads the top page, so these form targets all keep the submission in it.
const SAME_WINDOW = /^(_self|_top|_parent)?$/i;

// Keep exact DOM references in the browser, not selectors that a new document could reuse.
const readScript = `(() => {
  const sameWindow = ${SAME_WINDOW};
  const observe = () => ${browserLoginDetectionScript};
  if (observe() !== "credentials") return null;
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  // Some pages keep a decoy field for password managers: transparent and hidden from assistive technology.
  const shown = e => visible(e) && getComputedStyle(e).opacity !== "0" && !e.closest('[aria-hidden="true"]');
  // A modal dialog makes the page behind it unreachable, so only its forms count.
  const modal = [...document.querySelectorAll("dialog:modal")].pop();
  const forms = [...document.forms].filter(root => visible(root) && (!modal || modal.contains(root))).map(root => {
    const fields = [...root.querySelectorAll("input")].filter(e => shown(e) && e.type !== "hidden" && e.type !== "submit" && e.type !== "button");
    const buttons = [...root.querySelectorAll('button,input[type="submit"]')].filter(e => visible(e) && e.type === "submit" && !e.disabled);
    return { root, fields, buttons };
  }).filter(form => form.fields.length);
  if (forms.length !== 1) return null;
  const { root, fields, buttons } = forms[0];
  if (!fields.length || fields.length > 2 || buttons.length !== 1) return null;
  if (fields.some(e => !["email", "text", "password"].includes(e.type) || e.disabled || e.readOnly || /one-time-code|new-password/.test(e.autocomplete))) return null;
  if (fields.filter(e => e.type === "password").length > 1) return null;
  const button = buttons[0], action = new URL(button.getAttribute("formaction") || root.action, document.URL).href;
  if (new URL(action).origin !== location.origin || !sameWindow.test(root.target) || !sameWindow.test(button.formTarget)) return null;
  return { origin: location.origin, url: document.URL, root, fields, button, action, types: fields.map(field => field.type), observed: "credentials", observe };
})()`;

// Every element a sign-in step could use, whatever the page's structure. Typed values are never read.
const candidatesScript = `(() => {
  const observe = () => ${browserLoginDetectionScript};
  if (observe() === "challenge") return null;
  const modal = [...document.querySelectorAll("dialog:modal")].pop();
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && getComputedStyle(e).opacity !== "0" && !e.closest('[aria-hidden="true"]') && (!modal || modal.contains(e));
  const text = value => (value || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const inputs = [...document.querySelectorAll("input")].filter(e => visible(e) && ["email", "text", "password"].includes(e.type) && !e.disabled && !e.readOnly && !/one-time-code|new-password/.test(e.autocomplete)).slice(0, 12);
  const buttons = [...document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]')].filter(e => visible(e) && !e.disabled && e.getAttribute("aria-disabled") !== "true").slice(0, 20);
  if (!inputs.length || !buttons.length) return null;
  const described = {
    title: text(document.title),
    headings: [...document.querySelectorAll("h1,h2,h3")].filter(visible).slice(0, 5).map(e => text(e.textContent)),
    inputs: inputs.map(e => ({ type: e.type, label: text(e.getAttribute("aria-label") || e.labels?.[0]?.textContent || e.placeholder), name: text(e.name || e.id), autocomplete: text(e.autocomplete) })),
    buttons: buttons.map(e => text(e.textContent || e.value || e.getAttribute("aria-label"))),
  };
  return { inputs, buttons, described, observe };
})()`;

/** Binds the elements the model selected, after the same checks the fixed rules apply. */
async function chooseStep(page: Page, choose: LoginStepChooser): Promise<JSHandle<BoundForm | null> | null> {
  const candidates = await page.evaluateHandle(candidatesScript) as JSHandle<Candidates | null>;
  try {
    const described = await candidates.evaluate(found => found?.described ?? null);
    if (!described) return null;
    const choice = await choose(described);
    if (!choice) return null;
    return await candidates.evaluateHandle((found, { choice, sameWindowSource }) => {
      const sameWindow = new RegExp(sameWindowSource, "i");
      const fields = [choice.identity, choice.password].filter(index => index !== null).map(index => found!.inputs[index!]);
      const button = found!.buttons[choice.button];
      if (!button || fields.some(field => !field) || new Set(fields).size !== fields.length) return null;
      if (choice.password !== null && found!.inputs[choice.password].type !== "password") return null;
      if (choice.identity !== null && found!.inputs[choice.identity].type === "password") return null;
      const form = (button as HTMLButtonElement).form ?? null;
      const root = form && fields.every(field => field.form === form) ? form : null;
      const action = root ? new URL(button.getAttribute("formaction") || root.action, document.URL).href : null;
      if (root && (new URL(action!).origin !== location.origin || !sameWindow.test(root.target) || !sameWindow.test((button as HTMLButtonElement).formTarget ?? ""))) return null;
      return { origin: location.origin, url: document.URL, root, fields, button, action, types: fields.map(field => field.type), observed: found!.observe(), observe: found!.observe };
    }, { choice, sameWindowSource: SAME_WINDOW.source }) as JSHandle<BoundForm | null>;
  } finally { await candidates.dispose(); }
}

export async function readLoginStep(page: Page, requestId: string, choose?: LoginStepChooser) {
  const old = steps.get(page); steps.delete(page);
  if (old) await old.handle.dispose();
  try {
    let handle = await page.evaluateHandle(readScript) as JSHandle<BoundForm | null>;
    if (choose && await handle.evaluate(form => !form)) {
      // The card still works without the model: a failed choice leaves the step unsupported.
      const chosen = await chooseStep(page, choose).catch(error => { console.warn(`Sign-in card: could not choose the sign-in step with System AI: ${error instanceof Error ? error.message : error}`); return null; });
      if (chosen) { await handle.dispose(); handle = chosen; }
    }
    const metadata = await handle.evaluate(form => {
      if (!form) return null;
      return {
        origin: form.origin,
        fields: form.fields.map(input => ({
          type: input.type,
          label: (input.getAttribute("aria-label") || input.labels?.[0]?.textContent || input.placeholder || (input.type === "password" ? "Password" : "Username or email")).replace(/\s+/g, " ").trim().slice(0, 80),
          autocomplete: input.type === "password" ? "current-password" : "username",
        })),
        submitLabel: (form.button.textContent || (form.button as HTMLInputElement).value || form.button.getAttribute("aria-label") || "Continue").replace(/\s+/g, " ").trim().slice(0, 40),
      };
    });
    if (!metadata) {
      await handle.dispose();
      return { origin: new URL(page.url()).origin, stepId: null, fields: [], submitLabel: null, challenge: await page.evaluate(browserLoginDetectionScript) === "challenge" };
    }
    const id = randomUUID(); steps.set(page, { id, requestId, handle });
    return { ...metadata, stepId: id, challenge: false };
  } catch { throw new Error("Could not read sign-in step. Open the browser to continue."); }
}

export async function submitLoginStep(page: Page, input: { requestId: string; stepId: string; expectedOrigin: string; values: string[] }): Promise<void> {
  const step = steps.get(page); steps.delete(page);
  if (!step || step.id !== input.stepId || step.requestId !== input.requestId) {
    if (step) await step.handle.dispose();
    throw new Error("Sign-in step changed or expired. Refresh the card before continuing.");
  }
  try {
    await step.handle.evaluate((form, input) => {
      if (!form) throw new Error("changed");
      const sameWindow = new RegExp(input.sameWindowSource, "i");
      for (let index = 0; index <= form.fields.length; index++) {
        const root = form.root, button = form.button as HTMLButtonElement;
        const formIntact = !root || root.isConnected && button.form === root
          && new URL(button.getAttribute("formaction") || root.action, document.URL).href === form.action
          && sameWindow.test(root.target) && sameWindow.test(button.formTarget ?? "");
        const valid = document.URL === form.url && form.observe() === form.observed && form.origin === input.expectedOrigin && location.origin === form.origin
          && formIntact && button.isConnected && !button.disabled && button.getAttribute("aria-disabled") !== "true"
          && form.fields.length === input.values.length && form.fields.every((field, index) => field.type === form.types[index] && field.isConnected && (!root || field.form === root) && !field.disabled && !field.readOnly && ["text", "email", "password"].includes(field.type) && !/one-time-code|new-password/.test(field.autocomplete));
        if (!valid) throw new Error("changed");
        if (index === form.fields.length) { form.button.click(); break; }
        const field = form.fields[index];
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, input.values[index]);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, { expectedOrigin: new URL(input.expectedOrigin).origin, values: input.values, sameWindowSource: SAME_WINDOW.source });
  } catch {
    // Playwright call logs and website exceptions may contain entered credentials.
    throw new Error("Sign-in step changed or submission could not be confirmed. Check the current step; nothing will be retried automatically.");
  } finally { await step.handle.dispose(); }
}
