import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("phone conversations use the shared menu handle without a duplicate button", () => {
  const html = readFileSync("public/index.html", "utf8");
  const focus = readFileSync("public/app/focus-ui.js", "utf8");
  assert.equal((html.match(/id="focusControlsButton"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="chatMenuButton"/);
  assert.doesNotMatch(focus, /#chatMenuButton/);
  assert.match(focus, /bar\.append\(fab\)/);
});
