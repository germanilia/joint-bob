# Private GitHub updates implementation plan

> **For agentic workers:** Use executing-plans to implement these tasks in order.

**Goal:** Publish a bridge release from germanilia/joint-bob to both repositories, with authenticated hourly updates from the private repository.

**Architecture:** Each node reads a dedicated GitHub token from its own data directory. GitHub metadata and asset API calls authenticate only to the configured repository; redirected asset downloads never receive the token. CI builds once and mirrors the published package to iliagerman/joint-bob without pushing private source commits there.

**Tech stack:** Node.js, TypeScript, GitHub Actions, existing updater and installer.

**Spec:** User-approved direct GitHub-token option in this conversation. Old repository stays public until the user closes it after migration.

## Constraints

- Keep existing shared-checkout edits untouched; use a private index for commits.
- Do not distribute the publishing accounts' broad tokens to installations.
- No credentials in releases, URLs, logs, status responses, or replicated settings.
- Provisioning read-only machine tokens is separate from configuring CI publishing access.
- Keep release integrity checks and existing installation/rollback behavior.

## Review focus

- Missing/revoked credentials must fail visibly without falling back to public downloads.
- Never send Authorization to release CDN URLs or unrelated repositories.
- Cached releases from the old feed must not be installed after changing feed.
- Re-running CI must repair an incomplete mirror without replacing existing assets.
- Public release tags must not disclose new private commits through Git history.

## Tasks

- [ ] Add failing tests for scoped metadata/asset authentication, redirect stripping, token storage, CLI provisioning, hourly checks, and stale-feed cache rejection.
- [ ] Implement shared release authentication in scripts/release-auth.mjs, integrate src/updater.ts and scripts/self-update.mjs, add joint-bob update-token stdin command.
- [ ] Add a tested release mirror command and call it from the private repository's release workflow with a dedicated old-repository publishing secret.
- [ ] Document provisioning and migration. Run focused tests, typecheck, build, and full suite; report unrelated failures.
- [ ] Configure CI secret securely, commit only this task's files and release metadata, push, dispatch and verify the release workflow and both published artifacts.
- [ ] Report any machine-token provisioning still needed before closing the old repository.
