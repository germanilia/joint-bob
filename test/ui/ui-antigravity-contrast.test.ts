import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Antigravity's enabled new-conversation icon stays visible in every theme", { timeout: 120_000 }, async (t) => {
  const { page, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  const results = await page.evaluate(String.raw`(async () => {
    const { brandIcon } = await import("/app/icons.js");
    const button = document.createElement("button");
    button.className = "primary new-chat-harness-button";
    button.style.transition = "none";
    const icon = brandIcon("antigravity", "new-chat-harness-icon antigravity");
    button.append(icon);
    document.body.append(button);
    function luminance(color) {
      const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    }
    return ["light", "sepia", "dark", "midnight", "graphite"].map((theme) => {
      document.documentElement.dataset.theme = ["light", "sepia"].includes(theme) ? "light" : "dark";
      document.documentElement.dataset.palette = ["midnight", "graphite", "sepia"].includes(theme) ? theme : "default";
      const foreground = luminance(getComputedStyle(icon).color);
      const background = luminance(getComputedStyle(button).backgroundColor);
      return { theme, contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
    });
  })()`);
  for (const { theme, contrast } of results) assert.ok(contrast >= 3, `${theme}: icon contrast ${contrast.toFixed(2)} must be at least 3:1`);
});
