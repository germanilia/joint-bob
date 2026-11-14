import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("browser storage is limited to legacy migration and request-scoped sign-in notice state", async () => {
  const source = await appSource();
  const dismissalStart = source.indexOf("function isDismissed(key)");
  const dismissalEnd = source.indexOf("let popup =", dismissalStart);
  assert.ok(dismissalStart >= 0 && dismissalEnd > dismissalStart, "Missing sign-in dismissal helpers");
  const dismissal = source.slice(dismissalStart, dismissalEnd);
  assert.match(source, /const DISMISSAL_PREFIX = "joint-bob\.browser-login-dismissed:"/);
  assert.match(dismissal, /localStorage\.getItem\(DISMISSAL_PREFIX \+ key\) === "1"/);
  assert.match(dismissal, /localStorage\.setItem\(DISMISSAL_PREFIX \+ key, "1"\)/);
  assert.match(source, /const ANNOUNCEMENT_PREFIX = "joint-bob\.browser-login-announced:"/);
  assert.match(dismissal, /localStorage\.getItem\(ANNOUNCEMENT_PREFIX \+ key\) === "1"/);
  assert.match(dismissal, /localStorage\.setItem\(ANNOUNCEMENT_PREFIX \+ key, "1"\)/);
  assert.equal((dismissal.match(/\.(?:getItem|setItem|removeItem)\(/g) || []).length, 4);
  assert.match(source, /const requestKey = session => `\$\{session\.nodeId\}:\$\{session\.id\}:\$\{session\.loginRequest\.id\}`/);
  const app = source.slice(0, dismissalStart) + source.slice(dismissalEnd);
  const migrationStart = app.indexOf("async function migrateLegacyPreferences");
  const migrationEnd = app.indexOf("function showSignedOut", migrationStart);
  assert.ok(migrationStart >= 0, "Missing legacy preference migration");
  assert.ok(migrationEnd > migrationStart, "Missing end of legacy preference migration");
  const migration = app.slice(migrationStart, migrationEnd);

  assert.equal((app.match(/function migrateLegacyPreferences/g) || []).length, 1);
  for (const key of ["piWebTheme", "piWebNotifications", "piWebInstallDismissed", "piWebActiveView", "piWebActiveProjectId", "piWebActiveSessionPath"]) {
    assert.match(app, new RegExp(`"${key}"`));
  }
  for (const match of app.matchAll(/\.(?:getItem|setItem|removeItem)\(/g)) {
    const inMigration = match.index! >= migrationStart && match.index! < migrationEnd;
    const inDismissal = match.index! >= dismissalStart && match.index! < dismissalEnd;
    // Per-browser display preferences: the activity pane's width, the appearance (theme and text sizes), and in the
    // workspace's left column which list is shown and whether its filters are open, which page the app opens on, and
    // whether Bob's Live agents show as a list or as cards.
    const nearby = app.slice(Math.max(0, match.index! - 120), match.index! + 120);
    const displayPreference = ["WIDTH_STORAGE_KEY", "APPEARANCE_STORAGE_KEY", "COLUMN_KEY", "FILTERS_OPEN_KEY", "START_VIEW_KEY", "LAYOUT_KEY"].some((key) => nearby.includes(key));
    assert.ok(inMigration || inDismissal || displayPreference, "Web Storage access must be limited to migration, sign-in notice state, activity width, appearance, the left column's view or the start page");
  }
  assert.doesNotMatch(migration, /(?:credential|password|token)/i);
  assert.match(migration, /\["1", "true", "0", "false"\]\.includes\(legacy\.piWebNotifications\)/);
  assert.match(migration, /\["1", "true"\]\.includes\(legacy\.piWebNotifications\)/);
  assert.match(migration, /\["1", "true", "0", "false"\]\.includes\(legacy\.piWebInstallDismissed\)/);
  assert.match(migration, /\["1", "true"\]\.includes\(legacy\.piWebInstallDismissed\)/);
});

test("login is an accessible first-class application screen", async () => {
  const html = await readFile("public/index.html", "utf8");

  assert.match(html, /id="loginDialog"/);
  assert.match(html, /id="loginUsernameInput"[^>]*autocomplete="username"/);
  assert.match(html, /id="loginPasswordInput"[^>]*autocomplete="current-password"/);
  assert.match(html, /id="loginSubmitButton"/);
});
