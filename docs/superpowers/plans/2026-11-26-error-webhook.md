# Error webhook implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` for inline implementation. Check off steps after running the tests.

**Goal:** Let a node admin opt in to forwarding redacted error diagnostics to an HTTPS webhook.

**Architecture:** Keep a separate node-local webhook destination alongside ntfy. Browser errors enter the existing authenticated diagnostics endpoint. Backend errors use the existing error capture; each destination keeps its own delivery throttle.

**Tech stack:** Express, Zod, settings SQLite store, native fetch/FormData, plain DOM, Node test runner and the repository UI fixture.

**Spec:** Approved in the conversation: default off, configurable private default URL, use an attachment for long reports, prompt to set it up on errors, no raw transcripts or request bodies.

## Delivery and settings API

- [x] Add failing tests in `test/error-reporting.test.ts` for disabled-by-default even when `JOINT_BOB_ERROR_WEBHOOK_URL` is set, HTTPS-only overrides, reset, write-only URL, redacted long multipart logs, and independent delivery from ntfy.
- [x] Implement settings and delivery in `src/error-webhook.ts`. `GET/PUT /api/error-reporting/webhook` is node-admin only. `PUT` takes `{ enabled, url? }`, where omitted means keep the current override and empty means use the private default. The response is `{ enabled, destination, origin }` and never contains the full URL. Encrypt the stored override. A long diagnostic is a `text/plain` multipart part; short errors are JSON. Reject redirects and cap both request lifetime and attachment size.
- [x] Wire webhook delivery into `src/error-reporting.ts`, reusing the existing redaction and deduplication rules without changing ntfy settings or behavior. Delivery failures must not trigger another report.
- [x] Re-run the focused Node tests and typecheck.

## Browser intake and opt-in

- [x] Add a failing isolated browser test in `test/ui/ui-client-diagnostics.test.ts` for an error toast opening the disabled webhook settings, saving an explicit opt-in, and keeping API request bodies out of diagnostics.
- [x] Add the node-admin form under Settings → Notifications and link error toasts to it. Loading or clicking the link does not enable sending. Keep the URL input write-only. Include only bounded failed-request metadata with browser reports, never the full locally copied diagnostic or console history. Send uncaught exceptions and caught toast errors through the authenticated intake.
- [x] Test the admin boundary with member/admin sessions and run targeted UI and server checks. Use the Joint Bob worktree command with a real check on the candidate to finish integration.
