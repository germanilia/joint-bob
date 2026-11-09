import { randomUUID } from "node:crypto";
import type { JSHandle, Page } from "playwright-core";
import { browserLoginDetectionScript } from "./browser-login-detection.js";

interface BoundForm {
  origin: string;
  url: string;
  fields: HTMLInputElement[];
  button: HTMLButtonElement | HTMLInputElement;
  root: HTMLFormElement;
  action: string;
  types: string[];
  observe: () => string | null;
}
const steps = new WeakMap<Page, { id: string; requestId: string; handle: JSHandle<BoundForm | null> }>();

// Keep exact DOM references in the browser, not selectors that a new document could reuse.
const readScript = `(() => {
  const observe = () => ${browserLoginDetectionScript};
  if (observe() !== "credentials") return null;
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const forms = [...document.forms].filter(visible).map(root => {
    const fields = [...root.querySelectorAll("input")].filter(e => visible(e) && e.type !== "hidden" && e.type !== "submit" && e.type !== "button");
    const buttons = [...root.querySelectorAll('button,input[type="submit"]')].filter(e => visible(e) && e.type === "submit" && !e.disabled);
    return { root, fields, buttons };
  }).filter(form => form.fields.length);
  if (forms.length !== 1) return null;
  const { root, fields, buttons } = forms[0];
  if (!fields.length || fields.length > 2 || buttons.length !== 1) return null;
  if (fields.some(e => !["email", "text", "password"].includes(e.type) || e.disabled || e.readOnly || /one-time-code|new-password/.test(e.autocomplete))) return null;
  if (fields.filter(e => e.type === "password").length > 1) return null;
  const button = buttons[0], action = new URL(button.getAttribute("formaction") || root.action, document.URL).href;
  if (new URL(action).origin !== location.origin || root.target && root.target !== "_self" || button.formTarget && button.formTarget !== "_self") return null;
  return { origin: location.origin, url: document.URL, root, fields, button, action, types: fields.map(field => field.type), observe };
})()`;

export async function readLoginStep(page: Page, requestId: string) {
  const old = steps.get(page); steps.delete(page);
  if (old) await old.handle.dispose();
  try {
    const handle = await page.evaluateHandle(readScript) as JSHandle<BoundForm | null>;
    const metadata = await handle.evaluate(form => {
      if (!form) return null;
      return {
        origin: form.origin,
        fields: form.fields.map(input => ({
          type: input.type,
          label: (input.getAttribute("aria-label") || input.labels?.[0]?.textContent || input.placeholder || (input.type === "password" ? "Password" : "Username or email")).replace(/\s+/g, " ").trim().slice(0, 80),
          autocomplete: input.type === "password" ? "current-password" : "username",
        })),
        submitLabel: (form.button.textContent || (form.button as HTMLInputElement).value || "Continue").replace(/\s+/g, " ").trim().slice(0, 40),
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
      for (let index = 0; index <= form.fields.length; index++) {
        const valid = document.URL === form.url && form.observe() === "credentials" && form.origin === input.expectedOrigin && location.origin === form.origin
          && form.root.isConnected && form.button.isConnected && !form.button.disabled && form.button.form === form.root
          && new URL(form.button.getAttribute("formaction") || form.root.action, document.URL).href === form.action
          && (!form.root.target || form.root.target === "_self") && (!form.button.formTarget || form.button.formTarget === "_self")
          && form.fields.length === input.values.length && form.fields.every((field, index) => field.type === form.types[index] && field.isConnected && field.form === form.root && !field.disabled && !field.readOnly && ["text", "email", "password"].includes(field.type) && !/one-time-code|new-password/.test(field.autocomplete));
        if (!valid) throw new Error("changed");
        if (index === form.fields.length) { form.button.click(); break; }
        const field = form.fields[index];
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, input.values[index]);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, { expectedOrigin: new URL(input.expectedOrigin).origin, values: input.values });
  } catch {
    // Playwright call logs and website exceptions may contain entered credentials.
    throw new Error("Sign-in step changed or submission could not be confirmed. Check the current step; nothing will be retried automatically.");
  } finally { await step.handle.dispose(); }
}
