# Browser Login Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace automatic full-screen browser sign-in with a secure, conversation-local login card that follows ordinary login steps.

**Architecture:** Reuse pending login requests, browser ownership, signed cross-node routing, and completion verification. A human-only form-step protocol reads field metadata without values and accepts user submissions bound to a request, page, origin and form revision. A dedicated card renders outside the persisted transcript; browser takeover remains available for unsupported steps.

**Tech Stack:** Existing JavaScript frontend, TypeScript browser runtime, Playwright, Node test harness.

**Spec:** User-approved description in this conversation: secure sign-in card inside the conversation, current website and login step, credentials directly to browser without chat/model/log exposure, multi-step updates and errors, browser takeover for CAPTCHA/passkeys/unsupported steps, success followed by agent continuation.

## Global Constraints

- No passwords or submitted field values in transcripts, model context, persistence, telemetry, logs or returned errors.
- No automatic retry of a submission, especially after an uncertain network result.
- Agent stays paused until existing verified human completion returns control.
- CAPTCHA, passkeys and MFA remain human browser takeover; do not proxy or automate challenges.
- Preserve profile grants, conversation ownership, controller checks, and cross-node routing.
- No new dependencies. Work on main, preserving unrelated edits.

## Review Focus

- Stale form or same-tab navigation must reject before credentials are filled.
- Username-first and password-first transitions must not reuse a previous step's inputs.
- Wrong-password responses must remain visible without retrying or claiming success.
- Lost response, revoked access, or conversation changes must clear secret inputs and never replay submission.
- Mobile and desktop cards must fit without launching full-screen automatically; unsupported forms must offer explicit takeover.

## Task 1: Human-only, origin-bound login steps

**Files:** `src/browser-login-form.ts`, `src/browser-types.ts`, `src/browser-runtime.ts`, `src/server/browser.ts`; new `test/ui/browser-login-card-runtime.test.ts`.

**Interfaces:** Add `readLoginStep` and `submitLoginStep` browser commands restricted to the controlling human with a pending request. Read returns metadata and an opaque step ID, never field values. Submit consumes requestId, expectedPageId, expectedOrigin, stepId and field-ID/value pairs. Runtime owns a short-lived binding to exact page/document and form controls; consume it before mutation. Return no submitted values.

- [ ] Write isolated runtime tests for ordinary two-field forms, username-first transitions, challenge fallback, unsupported/ambiguous forms, and sanitized website errors.
- [ ] Add tests rejecting agent calls, wrong controllers, changed request/page/origin/document, detached or replaced fields, replayed steps and revoked access. Assert synthetic passwords never occur in responses/errors.
- [ ] Run `npm run test:file -- test/ui/browser-login-card-runtime.test.ts` and confirm new behavior fails before implementation.
- [ ] Extend the existing form reader with bounded metadata, unambiguous form/button selection and exact live-control binding; reject unsupported forms instead of guessing. Keep the existing agent `loginForm` behavior separate.
- [ ] Add schema and runtime operations. Validate bindings before filling and again before submission; never retry; sanitize Playwright errors rather than returning call logs containing entered text. Audit the HTTP/relay/error logging paths for request-body exposure.
- [ ] Run new tests plus `test/browser-api.test.ts`, `test/browser-login.test.ts`, and `npm run typecheck`.

## Task 2: Conversation sign-in card

**Files:** new `public/app/browser-login-card.js`; modify `public/app/browser-login.js`, relevant browser styles (check current diff before editing), and `src/browser-agent.ts`; new `test/ui/ui-browser-login-card.test.ts`.

**Interfaces:** `createBrowserLoginCard(host, options)` renders a pending request using authenticated browser commands, owns transient inputs, exposes `dispose()`, and invokes explicit browser takeover and verified completion callbacks. Existing `createBrowserViewer` remains the fallback. Keep the card above the composer in the requesting conversation, styled as a system card but never serialized into transcript messages.

- [ ] Write a browser test against loopback fixture forms for inline rendering, visible origin, username/password submission, username-first progression, rejection feedback, input clearing, and success via verified Done.
- [ ] Add tests for conversation switching, dismissal/reopening, unavailable browser node, uncertain submission (no replay), and explicit takeover for challenges or ambiguous controls.
- [ ] Assert desktop and phone geometry: card fits the conversation and viewport; no automatic fullscreen viewer. Verify no submitted values appear in transcript or browser storage.
- [ ] Run `npm run test:file -- test/ui/ui-browser-login-card.test.ts` and confirm the tests fail against the old full-screen behavior.
- [ ] Implement the card with DOM textContent for external labels, masked password fields, bounded metadata, disabled controls during submission, and secret clearing after submission/disposal. Surface transport failures without leaking raw errors. Display the actual current origin on every step and require another human action before submitting a changed step/origin.
- [ ] Replace default viewer mounting with the card. Preserve discovery and conversation scoping. Explicit Open browser invokes the existing viewer; allow returning to a freshly read card. Keep Done as human confirmation and reuse existing verification/continuation, rather than inferring authentication merely from a missing password field.
- [ ] Update agent instructions to explain the card and fallback without giving the agent access to credentials.
- [ ] Run new UI tests and existing login handoff, multi-step, mobile, focus, dismissal, unavailable-node and embedded tests; update obsolete fullscreen-default assertions while retaining explicit-fullscreen coverage.

## Task 3: Verification and review

- [ ] Run `npm run typecheck`, `npm run build`, and targeted browser runtime/API/login and UI suites through `npm run test:file`.
- [ ] Exercise cross-node human submission in the existing isolated browser cluster harness with synthetic credentials; verify the destination browser receives them and agent commands remain paused throughout.
- [ ] Review access boundaries, error/log redaction, stale step handling and disposal with fresh context. Fix findings and rerun affected tests.
- [ ] Inspect final diff for unrelated shared-checkout edits. Commit only this change using a private index per project guidance. Report exact tests and remaining limits; do not claim universal website compatibility or live deployment.

## Implementation record

Implemented the ordinary credential card and human-only opaque DOM-bound steps. The card fetches fresh session state before taking control, never persists its inputs, clears inputs before submission, offers explicit browser takeover and a return-to-card action, and requires verified human completion. Unsupported forms and challenges remain in the existing viewer. Website diagnostics emitted during pending login are excluded from later agent snapshots because sites can echo credentials in their console output.

Verification:
- Final runtime/API/agent/instruction/login/native handoff/cross-node suites: 71 passed.
- Final card/lifecycle/mobile/focus/fullscreen/embedded/dismissal/unavailable UI run: 22 passed and one 90-second dismissal timeout under concurrent load. Both dismissal cases passed on isolated rerun, completing the 23 checks.
- Real loopback end-to-end username → password → verified completion: passed.
- Existing conversation login lifecycle/stale response tests: 2 passed.
- Existing mobile/focus/fullscreen/embedded/dismissal/unavailable viewer checks: 17 passed (explicit takeover now precedes viewer assertions).
- Runtime/API/native handoff/cross-node suite: 65 passed; the two separate direct-viewer multi-step fixture cases timed out waiting for a frame. `public/app/browser-viewer.js` is unchanged. Those failures are not claimed fixed or proven pre-existing.
- `npm run typecheck` and `npm run build`: passed.

Review: attempted a fresh read-only reviewer; the configured child model failed before producing any review (unsupported model for that account). Performed an author review instead; no independent security-review claim.

Rulings: use a transient conversation-local system card rather than serialized transcript messages, so secrets cannot enter transcript storage; retain explicit human confirmation rather than guessing authentication from disappearance of a credential form. Display sanitized status and direct website error review to the browser, rather than copying potentially secret-bearing website error text.
