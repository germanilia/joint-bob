import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";

test("ownership buttons stay grouped and wrap below the notice without overflowing", async () => {
  const html = await readFile("public/index.html", "utf8");
  const css = await readFile("public/styles.css", "utf8");
  const notice = html.slice(html.indexOf('<div class="conversation-lock" id="conversationLock"'), html.indexOf('<div class="conversation-lock done-conversation-notice"'));
  const browser = await launchChrome({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 2739, height: 900 } });
    // Real notice markup and styles only; no app, accounts, or remote resources.
    await page.route("**/*", route => route.abort());
    await page.setContent(`<style>${css}</style>${notice}`);
    await page.locator("#conversationLock").evaluate(element => { element.hidden = false; });
    await page.locator("#conversationLockDetail").evaluate(element => {
      element.textContent = "This conversation is owned by Ilia's Macbook. Anything you send from here is rejected until you take ownership.";
    });
    for (const width of [2739, 1440, 768, 412, 390, 360, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const transferring of [false, true]) {
        await page.locator("#conversationLockTakeButton").evaluate((element, transferring) => {
          element.textContent = transferring ? "Cancel transfer" : "Take ownership";
        }, transferring);
        await page.locator("#conversationLockStatus").evaluate((element, transferring) => {
          element.textContent = transferring ? "Copying files to Mac: 3 files, 3.0 KB left…" : "";
        }, transferring);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const [noticeBox, copy, take, force] = await page.locator("#conversationLock, .conversation-lock-copy, #conversationLockTakeButton, #conversationLockForceButton").evaluateAll(elements => elements.map(element => {
          const { left, right, top, bottom, height } = element.getBoundingClientRect();
          return { left, right, top, bottom, height };
        }));
        const boxes = { notice: noticeBox, copy, take, force };
        const label = `${width}px, ${transferring ? "transferring" : "idle"}`;
        const sameRow = Math.abs(boxes.force.top - boxes.take.top) < 1;
        const gap = sameRow ? boxes.force.left - boxes.take.right : boxes.force.top - boxes.take.bottom;
        assert.ok(gap >= 6 && gap <= 12, `${label}: buttons must stay together, gap was ${gap}px`);
        for (const box of [boxes.copy, boxes.take, boxes.force]) {
          assert.ok(box.left >= boxes.notice.left && box.right <= boxes.notice.right, `${label}: content must fit inside the notice`);
          assert.ok(box.top >= boxes.notice.top && box.bottom <= boxes.notice.bottom, `${label}: notice must contain its content`);
        }
        assert.ok(boxes.force.right <= width, `${label}: buttons must not overflow the viewport`);
        assert.ok(Math.abs(boxes.take.height - boxes.force.height) < 1, `${label}: button heights must match`);
        if (width >= 1440) {
          assert.ok(sameRow, `${label}: desktop actions stay on one row`);
          assert.ok(boxes.take.left >= boxes.copy.right + 12, `${label}: actions must not overlap the message`);
        } else {
          assert.ok(boxes.take.top >= boxes.copy.bottom + 8, `${label}: narrow layouts put actions below the message`);
          if (width <= 412) {
            assert.ok(boxes.copy.right - boxes.copy.left >= width - 32, `${label}: phone text must use the full notice width, not a squeezed column`);
          }
        }
      }
    }
    // Ticket conversations hide both actions; the empty group must not add a row.
    await page.locator("#conversationLock button").evaluateAll(buttons => buttons.forEach(button => { button.hidden = true; }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const emptyRowGap = await page.evaluate(() => document.querySelector("#conversationLock")!.getBoundingClientRect().bottom - document.querySelector(".conversation-lock-copy")!.getBoundingClientRect().bottom);
    assert.ok(emptyRowGap <= 14, `hidden actions must not leave an empty row, bottom gap was ${emptyRowGap}px`);
  } finally {
    await browser.close();
  }
});
