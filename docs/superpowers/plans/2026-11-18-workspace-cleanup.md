# Workspace cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development.

**Goal:** Add recoverable workspace cleanup with one hourly job per node.

**Architecture:** The creator node owns retirement of a shared workspace. A read-only policy check supplies both preview and execution; execution rechecks after a durable Git save. Replicate opt-in to trusted twins and keep Git refs on their holding nodes.

**Tech Stack:** TypeScript, Node SQLite, Git plumbing, Express, vanilla browser modules.

**Spec:** `docs/superpowers/specs/2026-11-18-workspace-cleanup-design.md`

## Global constraints

- Automatic cleanup defaults off. Schedule at the top of each hour.
- One idle hour without conversations; more than 72 idle hours with conversations.
- Never delete conversation history. Do not touch the project's Git index or working directory.
- Refuse cleanup if the activity, sync, baseline or recovery check fails.

## Tasks and review focus

- [ ] Policy and scheduler: `src/server/workspace-cleanup.ts`, `src/server/worktree-cleanup.ts`, `src/server.ts`. Test boundary behavior, activity and done reconciliation bypasses.
- [ ] Recovery: `src/workspace-cleanup-git.ts` and `src/project-worktrees.ts`. Test additions, binary, deletions, executable bits, symlinks, exclusions, stable refs and restores from a fixture repo.
- [ ] Coordination: use the existing signed cluster and file sync APIs. Test inaccessible holders, mismatched snapshots and overlapping requests.
- [ ] Settings: `src/server/routes/workspace-cleanup.ts`, `public/app/workspace-cleanup-settings.js`, `public/index.html`. Verify preview does not mutate and disabled setting never triggers scheduled retirement.
- [ ] Run focused checks and typecheck; integrate using the existing Joint Bob worktree and push.
