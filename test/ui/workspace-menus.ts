import type { Locator, Page } from "playwright-core";

// Repository UI tests only. The desktop workspace (public/app/workspace.js) keeps some of the old panels' buttons in
// menus: the left column's ⋯ (recent, running, reviews, notes, issues, assistants), the conversation's ⋯ (Terminal,
// Browser, Notify, Rename, …) and the details column (Files, Git and Tasks summaries; the side chat, Story and the
// Activity overview under More). `reach` opens whatever holds a button so a test can press it as a person would.

const HOLDERS: Array<[selector: string, opener: string]> = [
  ["#workspaceMoreMenu", "workspace-more-button"],
  ["#workspaceNewMenu", "workspace-new-button"],
  ["#chatMoreMenu", "chat-more-button"],
  ["#detailsMoreMenu", "details-more-button"],
  ["#detailsFiles", "details-files-tab"],
  ["#detailsGit", "details-git-tab"],
  ["#detailsTasks", "details-tasks-tab"],
];

/** The button with this test id, made visible: its menu opened, or its details pane shown (opening the column first). */
export async function reach(page: Page, testid: string): Promise<Locator> {
  const target = page.getByTestId(testid).first();
  if (await target.isVisible()) return target;
  const holder = await target.evaluate((element, holders) => holders.find(([selector]) => element.closest(selector))?.[1] ?? null, HOLDERS);
  if (!holder) return target;
  if (holder.startsWith("details-") && !(await page.getByTestId(holder).isVisible())) {
    await page.getByTestId("chat-activity-toggle").click();
  }
  await page.getByTestId(holder).click();
  await target.waitFor();
  return target;
}
