import { chromium, type Browser, type LaunchOptions } from "playwright-core";
import { browserCapability } from "../../src/browser-runtime.js";

// Repository UI tests only. Drives the Chrome this node actually has, resolved by the same
// detection the product uses, so nodes without a system-wide Chrome still run the suite.
// Precedence: CHROME_PATH pins an absolute binary, CHROME_CHANNEL forces a named Playwright
// channel, otherwise browserCapability() resolves one.

/**
 * Absolute path of the Chrome this node drives. Tests that hand an executable to a dev node
 * need the path itself, not a launched browser. Fails with the product's own advice rather
 * than letting Playwright fall back to a bundled Chromium the node never downloaded.
 */
export async function chromeExecutable(): Promise<string> {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const capability = await browserCapability();
  if (!capability.executable) throw new Error(capability.reason ?? "No Chrome executable on this node");
  return capability.executable;
}

export async function launchChrome(options: LaunchOptions = {}): Promise<Browser> {
  const browser = !process.env.CHROME_PATH && process.env.CHROME_CHANNEL
    ? await chromium.launch({ ...options, channel: process.env.CHROME_CHANNEL })
    : await chromium.launch({ ...options, executablePath: await chromeExecutable() });
  return startInProjectsColumn(browser);
}

/** The desktop workspace's left column remembers Inbox or Projects in this key (public/app/workspace.js). */
export const WORKSPACE_COLUMN_KEY = "joint-bob-workspace-column";

/**
 * A project's list folds its filters (state chips, labels, Show done, Show scheduled, Mark all reviewed) behind the
 * Filters button and remembers the choice in this key; the suite, written against the filters, starts with them open.
 */
export const CONVERSATION_FILTERS_KEY = "joint-bob-conversation-filters-open";

/** The list of projects folds its own filter (clusters) the same way, behind the button beside its search box. */
export const PROJECT_FILTERS_KEY = "joint-bob-project-filters-open";

/**
 * The suite was written against the project and conversation lists, which the desktop workspace shows when its left
 * column is in Projects; a person who never chose starts in Inbox. Every context this browser opens starts in Projects
 * unless the page has chosen already, so a test that switches to Inbox keeps it through a reload. Tests of the Inbox
 * column set the key themselves (see ui-workspace-layout.test.ts).
 */
function startInProjectsColumn(browser: Browser): Browser {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args: Parameters<Browser["newContext"]>) => {
    const context = await newContext(...args);
    await context.addInitScript(([key, filtersKey, projectFiltersKey]) => {
      try {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, "projects");
        if (localStorage.getItem(filtersKey) === null) localStorage.setItem(filtersKey, "1");
        if (localStorage.getItem(projectFiltersKey) === null) localStorage.setItem(projectFiltersKey, "1");
      } catch { /* opaque origins have no storage */ }
    }, [WORKSPACE_COLUMN_KEY, CONVERSATION_FILTERS_KEY, PROJECT_FILTERS_KEY]);
    return context;
  };
  return browser;
}
