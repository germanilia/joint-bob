# Private GitHub updates

Bridge release `v2.248.0` uses `germanilia/joint-bob` for release metadata and downloads.
It checks hourly when automatic updates are enabled. Existing installation,
checksum verification, service activation, and rollback behavior are unchanged.

## Configure each machine

Create a separate fine-grained GitHub personal access token for each machine:

- Resource owner: `germanilia`.
- Repository access: only `joint-bob`.
- Repository permissions: **Contents: Read-only**. Metadata read access is implicit.
- Set an expiry and replace the token before it expires.

GitHub contents permission also allows reading the repository source. GitHub does
not offer a release-download-only permission for this direct-token approach.
Do not use the CI publishing token or a broad account token for installations.

Run `joint-bob update-token` as the OS user running Joint Bob, supplying the token
on stdin from a secret manager or a protected file. Do not put the token in command
arguments or shell history. For an installation without the CLI on PATH, invoke
`node <active-release>/bin/joint-bob.mjs update-token`.

The command writes `github-update-token` with mode `0600` inside the node's data
directory, normally `~/.joint-bob`. `JOINT_BOB_DATA_DIR` and `PI_WEB_DATA_DIR` select
the same directory used by the service. The token is not stored in project files,
the replicated database, release packages, or browser settings. No restart is
needed. Saving another token rotates it; removing the file disables private access.

Open Settings → Updates on that machine and select Check for updates. Then enable
Automatic updates if wanted. Every machine needs its own provisioning, including
machines updated through Update all nodes. Credentials are never forwarded to peers.
An expired, revoked, or missing token produces an update error. Replace the token,
then select Check for updates again. There is no fallback to the old public repository.

Only the configured GitHub repository's release API receives Authorization.
Downloads use asset API URLs with `Accept: application/octet-stream`. A GitHub CDN
redirect is fetched without Authorization. The archive's checksum is verified
before extracting or installing it.

`JOINT_BOB_RELEASE_API` remains available for explicit release-feed overrides and
isolated loopback tests. The updater does not read general `GH_TOKEN` or
`GITHUB_TOKEN` environment variables or an agent's secret accounts.

## Transitional publishing

The Release workflow runs in `germanilia/joint-bob`. After tests, it publishes the
private release. When the repository variable `LEGACY_RELEASE_REPOSITORY` is set
to `iliagerman/joint-bob`, it mirrors those exact assets using the Actions secret
`LEGACY_RELEASE_TOKEN`, which needs permission to publish releases in the old repo.
The workflow's own `GITHUB_TOKEN` only accesses the private source repository.

The mirror creates a draft in the destination, uploads both verified assets, then
publishes it. Re-running verifies existing files and repairs missing uploads; it
refuses to replace different bytes. No private Git refs are pushed to the public
repository. The public release tag points at its own `main`; the package's
`.joint-bob-release` marker identifies the private build commit.

Public release packages still include application code. They must be public for
old updaters to download this bridge release.

Before making the old repository private:

1. Verify each intended machine runs the bridge release or newer.
2. Provision its read-only token and verify a private update check and download.
3. Remove the `LEGACY_RELEASE_REPOSITORY` Actions variable and
   `LEGACY_RELEASE_TOKEN` secret from `germanilia/joint-bob` to stop mirroring.
4. Make `iliagerman/joint-bob` private.

Offline machines that miss the bridge need manual migration. Do not close the
public feed based on the date alone. Initial public installer URLs also stop
working after the old repository becomes private; new installations then need
an authenticated package download followed by `joint-bob install`.
