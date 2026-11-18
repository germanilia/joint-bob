# Dependency security implementation plan

**Goal:** Fix the reviewed Dependabot vulnerabilities without changing unrelated application behavior.

**Architecture:** Keep npm-shrinkwrap.json as the only authoritative dependency lock. Upgrade existing dependencies, retaining Express 4. Upgrade bundled Pi and migrate application validation to patched Zod 4. Use existing isolated tests and release packaging.

**Spec:** The three-stage plan approved in this conversation.

## Constraints and review focus

- Work only in this conversation's worktree; never install into its shared node_modules symlink.
- Use Node 24.22.1, disposable test data and loopback servers.
- Preserve JSON validation responses, schema defaults, signed cluster bodies and managed Pi fallback.
- Test compressed requests before authentication, oversized invalid collections, and bundled Pi session creation.
- Verify dependency audit and actual package installation, not just manifest version strings.

## Stage 1: HTTP, Claude and authoritative inventory

- [x] Add an isolated compressed-request crash regression and demonstrate failure before dependency updates.
- [x] Remove obsolete package-lock.json and update release lockfile checks and their tests.
- [x] Upgrade Express to 4.22.3, Claude to a patched pinned version, and resolve body-parser >=1.20.9 and qs >=6.16.1 in shrinkwrap.
- [x] Align installer pins and distribution assertions with patched versions.
- [x] Run focused HTTP, authentication and distribution tests.

## Stage 2: Bundled Pi

- [x] Upgrade bundled Pi to 1.5.2, aligning installer pin.
- [x] Run scripts/check-pi-sdk.mjs, Pi SDK/runtime/session checks and typecheck.
- [x] Confirm undici >=8.12.2, minimatch >=11.0.1, brace-expansion >=5.0.12 throughout shrinkwrap.

## Stage 3: Zod and prevention

- [x] Add bounded child-process regression for oversized invalid arrays and demonstrate the vulnerable behavior.
- [x] Upgrade Zod to 4.6.7, adapting only incompatible schema/type/error APIs; preserve existing response contracts.
- [x] Add scheduled dependency updates and CI audit of the authoritative production tree, without blanket ignores.
- [x] Run typecheck, build, full CI test suite and isolated UI smoke coverage; audit and install a packed release in a disposable directory.
- [x] Review changes and prepare the worktree CLI integration with a real verification command. Report precisely what passed and any remaining deployment or GitHub rescan work.

## Verification record

- Both new security regressions were observed failing with the old dependencies, then passing with patched versions.
- Typecheck, build, Pi SDK session-creation check, public dependency URL validation and the 29-test focused security/compatibility run passed.
- The isolated browser login/reload journey and its no-console-error/no-failed-request assertion passed.
- The packed release installed with a disposable HOME and empty npm configuration/cache using only the public registry. Its production audit reported zero vulnerabilities.
- Every one of the 833 server-suite files ran. After fixing migration-related fixtures and rerunning the cold-start test, 831 passed. The remaining assistant-teams-access and relay-transport failures also reproduced on unchanged upstream with the old dependency tree. They are not silently ignored by CI.
- Pi 1.5 changed package-install failures into warnings. The adapter preserves the previous unavailable status, verified by the existing readiness test failing before the adapter and passing afterward.
- A cold Pi session took 5.5 seconds to initialize. The deleted-record WebSocket test now allows 30 seconds rather than four for readiness; its deletion and protocol-close assertions are unchanged.
- Review was an author self-review. The independent review worker had no model API key and was stopped without repository edits.
- Main advanced during verification. The combined candidate passed typecheck, build, audit and Pi SDK checks. Its selected integration run passed 35 of 36 tests. The remaining PWA inventory assertion also fails on unchanged latest main because `/app/workspace-cleanup-settings.js` is absent from its offline shell. This security patch does not alter that UI inventory or suppress the assertion.
- Integration uses an object-only Git fallback after the worktree merge operation failed before allocation and PR integration reported conflicts in the release files. The combined tree preserves the newer changelog entries and leaves the shared checkout's files and staging index untouched.
