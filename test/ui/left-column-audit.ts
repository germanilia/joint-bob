// Measures the desktop workspace's left, projects and conversations columns: nothing sticks out of its column or
// scrolls sideways, and every piece of text reads at least 4.5:1 on what is behind it. Shared by the browser tests.
import { type Page } from "playwright-core";

export const THEMES: Array<[name: string, theme: string, palette: string]> = [
  ["system", "", ""], ["light", "light", ""], ["sepia", "light", "sepia"], ["dark", "dark", ""], ["midnight", "dark", "midnight"], ["graphite", "dark", "graphite"],
];

export async function setTheme(page: Page, theme: string, palette: string) {
  await page.evaluate(([name, tone]) => {
    if (name) document.documentElement.dataset.theme = name; else delete document.documentElement.dataset.theme;
    if (tone) document.documentElement.dataset.palette = tone; else delete document.documentElement.dataset.palette;
  }, [theme, palette]);
  // Colours ease from one theme to the next; measure them once they have arrived.
  await page.waitForTimeout(450);
}

/** Elements outside their column or columns that scroll sideways, at the page's current width. */
export async function auditFit(page: Page, columns = ["#workspaceSide", "#workspaceGroups", "#projectsPanel", "#chatsPanel"]) {
  await page.evaluate("window.__name = (value) => value"); // the test runner's compiler wraps named functions in this helper
  return page.evaluate((selectors) => {
    const found: string[] = [];
    const name = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`;
    for (const selector of selectors) {
      const column = document.querySelector<HTMLElement>(selector);
      if (!column || !column.getClientRects().length) continue;
      const frame = column.getBoundingClientRect();
      if (column.scrollWidth > column.clientWidth + 1) found.push(`${selector} scrolls sideways (${column.scrollWidth} > ${column.clientWidth})`);
      for (const element of column.querySelectorAll<HTMLElement>("*")) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || element.closest("[hidden]") || element.closest(".sr-only") || element.classList.contains("sr-only")) continue;
        if (element.closest("svg") && element.tagName.toLowerCase() !== "svg") continue;
        if (element.classList.contains("shortcut-hint")) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) continue;
        if (rect.right > frame.right + 0.5 || rect.left < frame.left - 0.5) found.push(`${selector}: ${name(element)} spans ${Math.round(rect.left)}–${Math.round(rect.right)} outside ${Math.round(frame.left)}–${Math.round(frame.right)}`);
        if (element.scrollWidth > element.clientWidth + 1 && !["visible"].includes(style.overflowX) && style.textOverflow !== "ellipsis" && element.clientWidth > 0 && element !== column) found.push(`${selector}: ${name(element)} scrolls sideways (${element.scrollWidth} > ${element.clientWidth})`);
      }
    }
    return found;
  }, columns);
}

/** Text in the columns below 4.5:1 against the fill behind it (the element's own opacity counts). */
export async function auditContrast(page: Page, columns = ["#workspaceSide", "#workspaceGroups", "#projectsPanel", "#chatsPanel"], minimum = 4.5) {
  await page.evaluate("window.__name = (value) => value");
  return page.evaluate(([selectors, floor]) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (colour: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = colour; context.fillRect(0, 0, 1, 1); const data = context.getImageData(0, 0, 1, 1).data; return [data[0], data[1], data[2], data[3] / 255]; };
    const over = (top: number[], under: number[]) => [0, 1, 2].map((index) => top[index] * top[3] + under[index] * (1 - top[3])).concat(1);
    const fillOf = (element: Element) => {
      const chain: Element[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) chain.unshift(node);
      return chain.reduce((colour, node) => { const style = getComputedStyle(node); const base = rgba(style.backgroundColor); return over([base[0], base[1], base[2], base[3] * 1], colour); }, [255, 255, 255, 1]);
    };
    const opacityOf = (element: Element) => { let value = 1; for (let node: Element | null = element; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity); return value; };
    const light = (colour: number[]) => { const part = (value: number) => { const unit = value / 255; return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; }; return 0.2126 * part(colour[0]) + 0.7152 * part(colour[1]) + 0.0722 * part(colour[2]); };
    const ratio = (one: number[], other: number[]) => { const [high, low] = [light(one), light(other)].sort((a, b) => b - a); return (high + 0.05) / (low + 0.05); };
    const found: string[] = [];
    for (const selector of selectors as string[]) {
      const column = document.querySelector<HTMLElement>(selector);
      if (!column || !column.getClientRects().length) continue;
      for (const element of column.querySelectorAll<HTMLElement>("*")) {
        const own = [...element.childNodes].some((node) => node.nodeType === 3 && (node.textContent ?? "").trim().length > 0);
        if (!own || !element.getClientRects().length || element.closest(".sr-only") || element.closest("[hidden]") || element.matches(":disabled") || element.classList.contains("shortcut-hint")) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || Number(style.fontSize.replace("px", "")) === 0) continue;
        const opacity = opacityOf(element);
        if (opacity < 0.05) continue;
        const fill = fillOf(element);
        const text = rgba(style.color);
        const value = ratio(over([text[0], text[1], text[2], text[3] * opacity], fill), fill);
        if (value < (floor as number)) found.push(`${selector}: "${(element.textContent ?? "").trim().slice(0, 24)}" ${element.tagName.toLowerCase()}.${String(element.className).split(" ")[0]} ${value.toFixed(2)}`);
      }
    }
    return found;
  }, [columns, minimum] as const);
}

/** Pager leftovers in the lists' columns: Previous/Next buttons, "1–8 of 80", "Page 1 of 4" or anything called a pager. */
export async function pagerLeftovers(page: Page, scopes = ["#workspaceSide", "#workspaceGroups", "#projectsPanel", "#chatsPanel", "#workspaceGroupPage", "#focusHome"]) {
  return page.evaluate((selectors) => {
    const found: string[] = [];
    for (const selector of selectors) {
      for (const scope of document.querySelectorAll<HTMLElement>(selector)) {
        if (!scope.getClientRects().length) continue;
        const text = scope.innerText;
        for (const pattern of [/\b\d+\s*[–-]\s*\d+\s+of\s+\d+\b/i, /\bpage\s+\d+\s+of\s+\d+\b/i]) if (pattern.test(text)) found.push(`${selector}: text matches ${pattern}`);
        for (const element of scope.querySelectorAll<HTMLElement>("*")) {
          if (!element.getClientRects().length) continue;
          const label = `${element.getAttribute("aria-label") ?? ""} ${element.title ?? ""} ${element.matches("button, a") ? element.innerText : ""}`.trim();
          const hooks = `${typeof element.className === "string" ? element.className : ""} ${element.dataset.testid ?? ""}`;
          if (/^(previous|next)( page)?$/i.test(label) || /pager|page-(previous|next)/i.test(hooks)) found.push(`${selector}: ${element.tagName.toLowerCase()} ${hooks.trim()} "${label}"`);
        }
      }
    }
    return found;
  }, scopes);
}
