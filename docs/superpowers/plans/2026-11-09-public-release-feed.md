# Public release feed implementation plan

**Goal:** Keep development private while installations update anonymously from `germanilia/joint-bob-releases`, with the migration package retained on `iliagerman/joint-bob`.

**Architecture:** Reuse GitHub Releases and the existing verified-asset mirror. Private CI publishes to the new public repository first, then the legacy repository. No customer credentials, GitHub App, or Homeserver token service.

**Scope approved:** Conversation request to create the public repo and leave a migration version on the old repo.

## Constraints

- Preserve newer committed changes from the old repository when joining its history to the private source repository.
- Never publish private source refs to either public repository.
- Keep the old repository public; mirror the same verified archive and checksum.
- Leave unrelated shared working-tree edits untouched. Test the exact candidate tree in a disposable directory.
- Existing private-feed installations without credentials need a one-time manual bridge installation; do not claim they can fetch the bridge automatically.

## Tasks

- [x] Create the public releases-only repository with an independent README history.
- [ ] Add failing tests for anonymous metadata/assets, stale token files, old feed caches, and CI publishing both destinations.
- [ ] Change the default feed in `scripts/release-auth.mjs`; keep explicit private overrides compatible, but never read tokens for the public feed.
- [ ] Update installer URLs, mirror release notes, workflow destinations and migration documentation.
- [ ] Merge committed public-source changes into the private candidate, resolve only release metadata/workflow conflicts, and bump to 2.249.0.
- [ ] Run focused tests, typecheck and build against the candidate; push to private main and await all CI shards.
- [ ] Configure only CI with the public publishing credential. Verify anonymous metadata/downloads and matching checksums on both public feeds.
- [ ] Update the releases-only README and installer without copying development history. Record the migration decision and verification.
