# Google Antigravity

Google Antigravity is a separate Joint Bob harness. It runs Google's official `agy acp` CLI, not a Pi provider. Install the official CLI and complete its native Google sign-in as the OS user running Joint Bob on each execution node. See [Google's ACP documentation](https://antigravity.google/docs/cli/acp/) and [headless CLI documentation](https://antigravity.google/docs/cli/headless/).

In **Settings > Harnesses > Google Antigravity**, set the executable, configuration path and transcript root. Defaults are `agy` on PATH, `~/.gemini`, and `~/.joint-bob/antigravity/sessions`. The CLI's `HOME` is the parent of the configured configuration path. Keep that path at `<CLI home>/.gemini` so native sign-in and Joint Bob use the same home.

Select **Google Antigravity** when creating a conversation. Models and thinking levels come from ACP configuration options. The default model leaves selection to Antigravity. An unavailable CLI or missing sign-in is reported before a turn starts. Model discovery retains a default entry when the CLI cannot be queried and logs non-authentication discovery errors.

The launch environment removes Google API-key, ADC and Vertex AI authentication variables so attached Google SDK credentials cannot silently replace native CLI login. Joint Bob never starts an automatic sign-in or uses Pi OAuth for this harness.

## Supported behavior

- Streaming replies and thinking, model selection, tool events and cancellation.
- Native session resume on the execution node, without duplicating ACP replay messages in the transcript.
- Joint Bob-owned JSONL history, persisted model settings, tool categories and titles.
- Guardian outgoing checks and checks for ACP tool permission requests. Tool categories apply to those permission requests; they do not sandbox the CLI or intercept tools it executes without requesting permission.

Compaction through Joint Bob is unsupported. Only Joint Bob-owned transcripts are listed; existing native CLI sessions are not imported. Transcripts can synchronize between nodes, but native Antigravity session state and authentication are not synchronized. Do not assume a transcript can resume on a different execution node.

## Verification

```sh
env -u GOOGLE_APPLICATION_CREDENTIALS npm run test:file -- test/antigravity-*.test.ts test/harness-*.test.ts
npm run typecheck
npm run build
```

Automated tests use a synthetic ACP executable with disposable data and no real Google account. They cover native login errors, model configuration, first turn, replay-safe resume, tool permission categories, transcript persistence, cancellation and malformed RPC replies. Authenticated smoke testing requires the official `agy` CLI installed and signed in on the execution node.
