# Private source, public updates

Development lives in private `germanilia/joint-bob`. Starting with `v2.249.0`,
installations check public `germanilia/joint-bob-releases` hourly when automatic
updates are enabled. Customers need no GitHub account, token, GitHub App, or
Homeserver service. Packages and their included application code are public;
the development repository and Git history remain private.

## Publishing

After the full test suite, the private repository's Release workflow publishes
its package, then copies the verified archive and checksum to:

1. `germanilia/joint-bob-releases`, using the `PUBLIC_RELEASE_TOKEN` Actions secret.
2. `iliagerman/joint-bob`, while `LEGACY_RELEASE_REPOSITORY` names it, using the
   separate `LEGACY_RELEASE_TOKEN` Actions secret.

The new feed publishes first so that the bridge is available there before old
installations migrate. Both mirrors receive exactly the same bytes. Retries
verify existing assets and repair partial uploads; different bytes are rejected.
Only CI holds publishing credentials. Public release tags point at each public
repository's own `main`; no private source refs are copied. The package's
`.joint-bob-release` marker identifies its build commit.

## Existing installations

Keep `iliagerman/joint-bob` public with `v2.249.0` or a newer migration release.
An old public-feed installation downloads that package normally, then checks
`germanilia/joint-bob-releases` after restarting. Automatic updates must be enabled
for an unattended migration; otherwise select Check for updates and install it.

The interim `v2.248.0` build used a private feed. Such an installation needs its
existing private credential for this one update, or a manual installation of the
public bridge package. A release on the old public feed cannot repair a client
that is already checking a different private feed without credentials.

The public default ignores `github-update-token`, even if an old token expired.
Explicit `JOINT_BOB_RELEASE_API` overrides are not silently changed; remove a
private-feed override to use the new default. The `joint-bob update-token` CLI
remains compatible for installations deliberately using an explicit private feed.
No App or token broker is required, and the unused App/private key is not deployed
or distributed by this migration.

## Fresh installs and manual migration

Download the archive and adjacent checksum from:

https://github.com/germanilia/joint-bob-releases/releases/latest

Verify the checksum, extract the archive, and run `node package/bin/joint-bob.mjs install`.
Alternatively, the public repository's `install.sh` downloads and verifies the
latest package before invoking its transactional installer. The standalone
installer's explicit `JOINT_BOB_REF` option still addresses old public source
commits; new private commits are installed from published packages instead.

## Retiring the old feed

Do not make the old repository private until every intended installation has
migrated or has a manual recovery path. Its migration release must remain publicly
reachable for offline installations that have not returned yet. After migration,
remove `LEGACY_RELEASE_REPOSITORY` and `LEGACY_RELEASE_TOKEN` from private CI, then
change the old repository's visibility only with the owner's approval. The new
releases-only repository stays public permanently.
