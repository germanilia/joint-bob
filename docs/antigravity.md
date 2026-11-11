# Google Antigravity

Google Antigravity is a separate Joint Bob harness. It runs Google's official `agy acp` CLI, not a Pi provider. Joint Bob automatically installs the official CLI on each execution node at release startup, then checks for updates daily. **Settings > Updates > Update harnesses now** also installs or repairs it. Downloads come from Google's GitHub releases, are SHA-256 verified, and must pass version and ACP checks before replacing the previous installation. Google consent is completed by the person through the in-app sign-in controls described below. See [Google's ACP documentation](https://antigravity.google/docs/cli/acp/) and [headless CLI documentation](https://antigravity.google/docs/cli/headless/).

In **Settings > Harnesses > Google Antigravity**, set the executable, machine-level configuration path and transcript root. Defaults are `<Joint Bob data>/harnesses/antigravity/bin/agy`, `~/.gemini`, and `~/.joint-bob/antigravity/sessions`. Explicit custom executable paths are preserved. Managed downloads support macOS and Linux on ARM64 and x64. The machine-level CLI's `HOME` is the parent of the configured configuration path. Named profiles use their own isolated CLI homes, independent of this machine-level path.

Select **Google Antigravity** when creating a conversation. Models and thinking levels come from ACP configuration options. The default model leaves selection to Antigravity. An unavailable CLI or missing sign-in is reported before a turn starts. Model discovery retains a default entry when the CLI cannot be queried and logs non-authentication discovery errors.

The launch environment removes Google API-key, ADC and Vertex AI authentication variables so attached Google SDK credentials cannot silently replace native CLI login. Joint Bob starts sign-in only when the node administrator clicks **Sign in with Google**. It does not use Pi OAuth for this harness.

## Sign in from Joint Bob

For a named Google account, open **Settings > Connections > Profiles > Google Antigravity**, add a profile, then click **Sign in** on its card. Assign the profile under **Settings > Connections > Assignments**. Each profile runs the official `agy acp --login` terminal flow with its own isolated CLI home. Open the provided Google authorization link, complete Google's sign-in and consent yourself, then paste the authorization code or final redirect URL into the masked field and click **Continue**. The profile and its sign-in are local to each execution node; sign in separately on every node where it should run. Antigravity profiles are private and cannot be shared or pooled.

The administrator can also use **Settings > Harnesses > Google Antigravity > Sign in with Google** for this node's machine-level account. That remains the administrator's fallback when no profile is selected; other users must select their own profile. The machine-level flow uses the configured native home. Both flows work when the execution node is a remote Linux server.

The CLI stores credentials through its native authentication mechanism on that node. Joint Bob sends the submitted response directly to the CLI over stdin. It never includes submitted codes, tokens or raw CLI output in login status responses. The app accepts only Google's authorization URLs, rejects multiline input, verifies the resulting ACP sign-in and refreshes available models and harness readiness. A rejected code is not retried automatically. **Cancel sign-in** terminates the pending CLI process; unfinished sign-ins time out after 15 minutes. New Antigravity turns wait until sign-in finishes.

Harness executable, path and machine-level sign-in controls are restricted to local node administrators. Profile login is available to the profile's owner. Neither flow transfers credentials to another execution node. Save path overrides before starting machine-level sign-in. After an app restart, start a new sign-in from Connections or Harnesses if needed.

## Supported behavior

- Streaming replies and thinking, model selection, tool events and cancellation.
- Native session resume on the execution node, without duplicating ACP replay messages in the transcript.
- Joint Bob-owned JSONL history, persisted model settings, tool categories and titles.
- Guardian outgoing checks and checks for ACP tool permission requests. Tool categories apply to those permission requests; they do not sandbox the CLI or intercept tools it executes without requesting permission.

Compaction through Joint Bob is unsupported. Only Joint Bob-owned transcripts are listed; existing native CLI sessions are not imported. Transcripts can synchronize between nodes, but native Antigravity session state and authentication are not synchronized. Switching profiles starts a separate native session while keeping the visible conversation history. Do not assume a transcript can resume on a different execution node.

## Verification

```sh
env -u GOOGLE_APPLICATION_CREDENTIALS npm run test:file -- test/antigravity-*.test.ts test/harness-*.test.ts
npm run typecheck
npm run build
```

Automated tests use a synthetic ACP executable with disposable data and no real Google account. They cover private profile assignment, per-profile CLI home isolation, native session separation, native login errors, model configuration, first turn, replay-safe resume, tool permission categories, transcript persistence, cancellation and malformed RPC replies. `npm run test:file -- test/ui/ui-antigravity-login.test.ts` exercises the real Settings UI and HTTP routes against an isolated node, including sign-in, code rejection, cancellation, verification, CSRF enforcement and readiness refresh. Authenticated smoke testing requires the official `agy` CLI installed and signed in on the execution node.
