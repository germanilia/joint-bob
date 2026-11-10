# Paper · Editorial UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the whole Joint Bob web app the Paper · Editorial look the user chose on 2026-11-10, in phases that each ship on their own.

**Architecture:** Phase 1 adds one stylesheet, `public/paper.css`, loaded after every other stylesheet. It resets the app's existing design tokens per theme and restyles shared components, so today's screens take the new look without markup changes. Later phases change structure (dropdowns, Settings, workspace, phone, Home and Bob), each with its own plan.

**Tech Stack:** plain CSS and ES modules in `public/`, Node test runner (`npm run test:file`), browser suite in `test/ui` (`npm run test:ui`, outside CI).

**Spec:** `docs/superpowers/specs/2026-11-10-ui-redo-paper-design.md`; reference look: `mocks/ui-redo/index.html`, version "Editorial" (`.dN.v2.ed` in `mocks/ui-redo/src/n.css`).

## Global Constraints

- No framework and no front-end build step; CSP `default-src 'self'`, so fonts ship in `public/fonts/` with their OFL licence files.
- Six themes stay, through the existing mechanism: `:root[data-theme="light"|"dark"]` plus `data-palette="sepia"|"midnight"|"graphite"` set by `public/app/appearance.js`; "System" is no stored theme.
- New shell files go in `APP_SHELL` in `public/sw.js`; the served cache name follows the files' contents, so `CACHE_NAME` is not bumped by hand.
- Young Serif has one weight (400): serif text is never set bolder than 400.
- No feature is removed and no server code changes in phases 1–2.
- Lists page instead of scrolling; the control center is left only by the person.

## Review Focus

- Theme switching at runtime (Settings → Appearance) recolours everything at once, with no element left in the old palette: check all six themes on the main screen, Settings and the phone.
- Hebrew and other non-Latin text falls back to the system font cleanly (DM Sans and Young Serif are Latin subsets).
- Text-size scaling (Appearance presets up to Huge) still fits headers and toolbars without wrapping.
- Code, diffs and the terminal keep their monospaced font and dark code colours.
- Focus rings stay visible in every theme.

---

## Phase 1 — The style layer (this plan) — done 2026-11-10, not committed

Result: `public/paper.css` + `public/fonts/`; `test/paper-style.test.ts` and the four related tests pass; checked by eye on a dev node in Light, Dark, Midnight, Sepia and at phone width. `test/ui/ui-smoke.test.ts` has two failures ("running conversations open their live conversation in another project", "a digit typed into a dialog's search box…") that fail the same way without `paper.css`. Left for later phases: about 34 small uppercase labels outside the shared label classes.

### Task 1: Fonts and the stylesheet are shipped

**Files:**
- Create: `public/fonts/dm-sans.woff2`, `public/fonts/young-serif.woff2`, `public/fonts/dm-sans-OFL.txt`, `public/fonts/young-serif-OFL.txt`, `public/paper.css`
- Modify: `public/index.html` (one `<link rel="stylesheet" href="/paper.css">` after every other stylesheet), `public/sw.js` (`APP_SHELL` gains `/paper.css`, `/fonts/dm-sans.woff2`, `/fonts/young-serif.woff2`)
- Test: `test/paper-style.test.ts`

- [x] **Step 1: Write the failing test** `test/paper-style.test.ts`:
  - "the Paper stylesheet loads after every other stylesheet": the last `rel="stylesheet"` href in `public/index.html` is `/paper.css`.
  - "Paper fonts ship with their licences": both `.woff2` and both `-OFL.txt` files exist; `public/paper.css` has `@font-face` rules for `"DM Sans"` and `"Young Serif"` pointing at `/fonts/…`.
  - "the worker caches the Paper files": `APP_SHELL` in `public/sw.js` contains the three paths above.
- [x] **Step 2:** `npm run test:file -- test/paper-style.test.ts` fails.
- [x] **Step 3:** Add the files (fonts from `mocks/ui-redo/src/fonts/*.b64`, decoded), the link and the shell entries.
- [x] **Step 4:** The test passes; `test/public-distribution.test.ts` still passes ("every PWA shell asset exists").

### Task 2: Tokens for the six themes

**Files:** Modify `public/paper.css`; Test: `test/paper-style.test.ts`

- [x] **Step 1: Failing test** "Paper sets the tokens for every theme": `paper.css` has a block for `:root`, `:root[data-theme="dark"]`, `:root[data-theme="dark"][data-palette="midnight"]`, `:root[data-theme="dark"][data-palette="graphite"]`, `:root[data-theme="light"][data-palette="sepia"]`, and each sets `--bg`, `--panel`, `--header`, `--surface`, `--field`, `--line`, `--text`, `--muted`, `--accent`, `--btn-bg`, `--btn-fg`.
- [x] **Step 2:** Run, see it fail.
- [x] **Step 3:** Values from `mocks/ui-redo/src/n.css` (`.dN.v2` and the theme blocks): light `--bg #f2ebdf`, `--panel #fffbf4`, `--field #f6f0e5`, `--text #2b241c`, `--muted #6e6457`, `--accent #2f6b4f`; dark/midnight/graphite/sepia as in the mock, dark accent `#7fcf9f`. `--sans` = DM Sans stack, `--serif` = Young Serif stack, radii 16/12/10.
- [x] **Step 4:** Test passes.

### Task 3: Components take the look

**Files:** Modify `public/paper.css`

- Serif headings at weight 400 (every rule that uses `var(--serif)` today, and the dialog titles).
- Eyebrows and section labels (today mono, uppercase, letter-spaced) become small sans labels in sentence case, or serif labels where the mock uses them (group labels, section titles).
- Buttons: primary = accent with light text; secondary = raised fill; ghost = hairline. Fields: filled, no heavy border, accent focus ring.
- Panels and dialogs: cream cards on sand, soft shadow (hairline instead of shadow in dark themes), radius 24 for dialogs.
- [x] **Step 1:** Implement.
- [x] **Step 2: Verify by looking** — run a disposable dev node (`JOINT_BOB_DEV_ROOT=$(mktemp -d) PORT=8797 ./scripts/dev-local.sh`, sign in `dev` / `joint-bob-dev-password`) and check the main screen, Settings (Account, Connections, Browser), the control center and the phone width in Light, Sepia, Dark, Midnight and Graphite. Fix what does not take the look.
- [x] **Step 3:** `npm run test:file` for `test/paper-style.test.ts`, `test/public-distribution.test.ts`, `test/pwa-worker-fallback.test.ts`, `test/rebrand-audit.test.ts` pass; the browser tests `test/ui/ui-appearance.test.ts` and `test/ui/ui-smoke.test.ts` pass.

## Later phases (one plan each, written when the previous phase ships)

2. **Searchable dropdowns everywhere** — built 2026-11-10, not committed (see "Phase 2 — as built" below): `public/app/searchable-select.js` matches with `fuzzyMatch` from `public/app/fuzzy.js`, marks matched letters and opens as a bottom sheet on the phone; every native `<select>` in `public/index.html` (105) is upgraded through one helper that keeps the `<select>` as the source of truth; `spotlight.js` uses the same matcher; composer type-ahead for `/` and `@`.
3. **Settings as a page:** the dialog becomes a page with its own list; the three section kinds; the shared Save settings button goes once every section saves on its own; the theme tiles on Account.
4. **Desktop workspace:** left column (search, Bob, Inbox, Projects, Board, Automations, Costs, grouped conversations), conversation header with the four chips and a ⋯ menu for today's toolbar, details column.
5. **Phone:** Home with the greeting, tabs Inbox · Bob · Projects · Settings, details as a sheet, 44 px targets.
6. **Home and Bob pages:** Home's cards with Answer / Push it on / Done; the control center as Bob's page; then the assistant app.

## Phase 2 — as built (2026-11-10, not committed)

- `public/app/fuzzy.js`: `fuzzyHits(query, text) → { score, hits } | null` (positions of the matched letters); `fuzzyScore` and `fuzzyMatch` unchanged in meaning; `rankChoices(query, choices) → [{ choice, hits }]` — label matches loosely, value/detail/keywords must contain the typed text (dots, spaces, dashes ignored); no query keeps the order.
- `public/app/choice-popover.js`: the one list — search box, ranked rows with `<mark>`ed letters, optgroup headings when nothing is typed, keyboard (arrows, Enter, Escape closes only the list, Tab), a bottom sheet with a scrim at ≤ 700 px that does not raise the keyboard until the search box is tapped. `markedText(text, hits)` is shared.
- `public/app/searchable-select.js`: same API and test ids, now built on the shared list.
- `public/app/select-search.js` (`installSelectSearch()`, called from `public/app.js`): every plain `<select>` (not `multiple`, size ≤ 1, not inside `[data-native-select]`) opens the shared list on mouse, tap (not after a scroll) or keyboard (Enter, Space, arrows, F4, or a typed letter that starts the search). The `<select>` stays the source of truth and gets `input` + `change`.
- Workspace search (`spotlight.js`): its own destinations rank with `rankChoices`, titles show marked letters (server search was already fuzzy).
- Message box (`composer-dialogs.js`): `/` commands rank with `rankChoices` and mark letters; new `@` file suggestions walk the project one folder at a time through `GET /api/projects/:id/files?dir=`, re-read after 30 s; choosing a folder steps into it, a file inserts `@path `.
- Tests: `test/fuzzy-hits.test.ts`; `test/ui/ui-select-search.test.ts` (4 checks). `test/ui/ui-dropdown-styling.test.ts` failed before this work on the control center's compact pickers (padding since 2026-11-05); `public/paper.css` now gives them room for the chevron.
