# Contigos Telegram team implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a plan, not permission to start implementation or deploy.

**Goal:** Run Bob and five configurable specialists on the Contigos relay EC2, shared by its cluster through one Telegram bot, with proactive triage, direct calls, tracked coordination and filesystem subject memory.

**Architecture:** Add an explicit cluster-scoped team around existing assistant configurations, conversation execution and resource handling. The EC2 hosts the authoritative team store, Telegram receiver, work queue and memory. Code checks membership and reply destinations; the central decision model handles semantic attention/topic choices; Bob coordinates the work.

**Tech Stack:** Existing TypeScript/Node, Express, SQLite, Markdown files, vanilla browser JavaScript, Telegram Bot API, existing agent runtime and TypeSafe/Laya decision adapters. One QR encoder dependency is justified if no suitable implementation is available when building the UI; never use a remote QR service.

**Spec:** [Contigos Telegram assistant team](../specs/2026-11-09-contigos-telegram-team-design.md).

## Global constraints

- R1–R10 in the spec are the requirement contract. Engineering defaults are labelled separately there.
- All six agents execute on EC2; no laptop dependency or execution fallback.
- Flat access for the selected cluster; no per-agent ACLs. Same relay is not membership. Preserve personal assistant ownership checks.
- Proactive defaults are strictly `confidence > 0.95` to act, `confidence > 0.80` to ask, otherwise silent; a `none` choice never acts. Direct calls bypass this gate.
- Team thresholds live in Bob control-center settings, centrally stored on EC2. Team classification uses `systemAiSettings().decision` and `systemDecisionKey`, not personal Bob/assistant selections.
- One Telegram identity. Direct specialist answers go to the group; delegated answers go only to Bob. Only accepted assignments get acknowledgments.
- No independent specialist monitoring, Auto respond, recursive asks or personal Bob review-check nudges. Existing Guardian and human decisions remain enforced.
- Filesystem subject memory plus SQLite history; no vector/graph database, public discovery, multi-host workflow engine or automatic failover.
- Use push on changes and startup recovery. No periodic cluster polling.
- Read `TESTING.md`; use disposable HOME/data, loopback fixtures, mocked model/Telegram/runtime calls and cleanup. Do not make live paid model calls in automated tests.
- MCP credentials remain user- and node-local. A Claude plugin login does not establish Pi/Kiro access. Read `.agents/knowledge/mcp-authentication.md` before resource work.
- No branches/worktrees unless the user requests a Joint Bob worktree. Preserve unrelated files in this shared checkout. Use a private git index for atomic, task-owned commits; never blanket-stage.

## Review focus

1. High confidence that no action is needed must not start work; exact 80%/95% boundaries and direct-call exceptions belong to Task 5.
2. A second cluster on the same relay, forwarded invites, or removed members must not inherit access; enforce at admission and execution in Tasks 1, 3 and 7.
3. Two people interleaving subjects, edited messages and delayed child results must preserve the correct conversation and reply destination; Tasks 4–6.
4. A crash after an external send/agent dispatch but before its receipt must not duplicate work; Task 6 recovery and Task 10 crash injection.
5. Subject writes during quiet discussion must not start specialists, leak personal notes or lose concurrent edits; Task 8.

## Repository findings and implementation boundary

Reviewed against `main` at `7015d453` on 2026-11-09. `git pull --ff-only origin main` reported already up to date. Another session's modified `test/quality-analytics.test.ts` was left untouched.

Do not solve this by removing the group-leave check from `src/control-center/telegram-updates.ts`, or by permitting all webhook calls in `src/assistant-collaboration/ask.ts`. Both would route outside users into owner-private flows. Introduce the team boundary first, then reuse the underlying execution/storage functions through authenticated team entry points.

Core implementation will be sequential because the access, conversation and assignment contracts depend on each other. Independent read-only reviews can accompany each task; do not run competing editors on the common runtime files.

## File responsibilities

New files below are planned files, not files created by this planning task.

| Planned file | Responsibility |
| --- | --- |
| `src/assistant-teams/store.ts` | Team/agent configuration, schema and persisted settings; authoritative host and execution identity. |
| `src/assistant-teams/access.ts` | Resolve verified cluster member and execution access; no model calls. |
| `src/assistant-teams/runtime.ts` | Team-specific adapter to existing assistant runtime/resources, actual caller attribution. |
| `src/assistant-teams/telegram-store.ts` | Bot/group bindings, enrollment, durable incoming events and outbound receipts. |
| `src/assistant-teams/telegram.ts` | Webhook validation, enrollment/group challenge, update parsing and normalization. |
| `src/assistant-teams/conversations.ts` | Subject records, per-agent topic mapping, bounded context and direct-reply lookup. |
| `src/assistant-teams/questions.ts` | Attention, conversation and memory decision questions and threshold defaults. |
| `src/assistant-teams/decisions.ts` | Central decision-model calls, validation and deterministic threshold policy. |
| `src/assistant-teams/assignments.ts` | Assignment state transitions, confirmations, delegation and restart reconciliation. |
| `src/assistant-teams/tools.ts` | Bob-only assignment tools, bound to a live team turn and root assignment. |
| `src/assistant-teams/delivery.ts` | Server-owned acknowledgment, inquiry and final-result publication. |
| `src/assistant-teams/memory.ts` | Subject learning, serialized revisioned writes, index and change review. |
| `src/server/routes/assistant-teams.ts` | Signed-in team API, scoped signed-peer facade and change events. |
| `src/server/routes/assistant-team-telegram.ts` | Public authenticated webhook endpoint and member configuration/enrollment endpoints. |
| `public/app/control-team.js` | Team selection, agent configuration, live task view and settings integration. |
| `public/app/control-team-telegram.js` | Telegram readiness, QR/link enrollment and group binding. |

Keep existing functions when usable. Extract a narrowly shared operation from an existing route module only when its team caller needs it; do not make a second resource/runtime implementation. New imports into `src/server.ts` and the control-center shell should be additive and small.

## Shared contracts

Persisted record types below live in `store.ts` and are defined in Task 1 so later tasks never import not-yet-created modules. `ClusterMember`/`TeamMember` live in `access.ts`. Behavior stays in the responsible modules listed above. IDs are opaque strings validated at HTTP/CLI boundaries. `TeamMember` is constructed only by `access.ts`; requests cannot submit it as an authorization claim.

```ts
// store.ts
export type TeamRole = "bob" | "product" | "designer" | "qa" | "pr_reviewer" | "support";
export interface TeamSettings { askThreshold: number; actThreshold: number }
export interface AssistantTeam {
  id: string; clusterId: string; hostNodeId: string; projectId: string;
  executorAccountId: string; settings: TeamSettings; revision: number;
}
export interface TeamAgent { teamId: string; role: TeamRole; assistantId: string }
// access.ts
export interface ClusterMember { clusterId: string; accountId: string; homeNodeId: string; username: string }
export interface TeamMember extends ClusterMember { teamId: string }
// store.ts: message/subject records consumed by conversations.ts
export interface TeamMessage {
  id: string; teamId: string; accountId: string; chatId: string;
  telegramMessageId: number; threadId: number | null; replyToMessageId: number | null;
  text: string; revision: number; createdAt: string;
}
export interface TeamSubject { id: string; teamId: string; title: string; summary: string }
export type TeamRoute = { kind: "new" } | { kind: "continue"; subjectId: string } |
  { kind: "clarify" };
// store.ts: assignment records consumed by assignments.ts and runtime.ts
export type AssignmentState = "accepted" | "queued" | "running" | "waiting_for_human" |
  "completed" | "failed" | "cancelled" | "uncertain";
export type ResultDestination = { kind: "group"; sourceMessageId: string } |
  { kind: "bob"; parentAssignmentId: string };
export interface TeamAssignment {
  id: string; teamId: string; rootId: string; parentId: string | null;
  subjectId: string | null; role: TeamRole; requestedBy: string; sourceMessageId: string;
  destination: ResultDestination; state: AssignmentState; requestId: string;
}
```

Store Telegram attachment descriptors separately using the current `TelegramFile` representation. Store sender identity, full text and edit versions durably; model context is a separate bounded projection. Routing mapping keys are `(teamId, subjectId, assistantId)` and actual Telegram output IDs, not last-used global conversation.

### Task 1: Shared team ownership and access

**Files:** Create `src/assistant-teams/store.ts`, `access.ts`, `src/server/routes/assistant-teams.ts`, `test/assistant-teams-access.test.ts`. Modify `src/server.ts`, and the narrowly scoped route admission in `src/server/http-auth.ts` only if required by the signed peer facade.

**Interfaces:** `requireClusterMember(session: AuthSession, clusterId: string): Promise<ClusterMember>`; `createTeam(member: ClusterMember, input: { projectId: string; executorAccountId: string }): Promise<AssistantTeam>`; `requireTeamMember(session: AuthSession, teamId: string): Promise<TeamMember>`; `requireTeamExecution(teamId: string, accountId: string): Promise<TeamMember>`; `saveTeamSettings(member: TeamMember, settings: TeamSettings, expectedRevision: number): Promise<AssistantTeam>`. Creation uses the verified cluster actor before the team exists; the team ID is never manufactured to satisfy an access check.

- [ ] Write access tests: both independently homed members have identical access; same-relay outsider gets 403; forged home/account pairing fails; missing/closed cluster and removed membership fail; unknown team returns 404; stale revision returns 409. Include a real signed non-twin cluster fixture, not only twins.
- [ ] Run `npm run test:file -- test/assistant-teams-access.test.ts`; verify failures name the missing team implementation.
- [ ] Implement additive `assistant_teams`, `assistant_team_agents` and base `assistant_team_assignments` record tables, including the shared types above. Base assignment insert/read supports Task 2's runtime tests; no dispatch loop exists until Task 6. Enforce unique team per cluster/host for this version, defaults `{ askThreshold: 0.80, actThreshold: 0.95 }`. Check actual cluster IDs and signed account-home authority, including visitor cluster claims; never infer membership from `sharesRelay` alone. Bind the server-resolved EC2-local execution account and dedicated project, reject private-project reuse. `executorAccountId` is an internal setup argument, not a caller-controlled HTTP field. Return the same team view to both members.
- [ ] Implement `GET /api/assistant-teams`, `POST /api/assistant-teams`, `GET /api/assistant-teams/:id`, `PUT /api/assistant-teams/:id/settings` with session/CSRF checks. A signed `/api/cluster/v2/assistant-teams/:operation` facade validates sender, home/account authority and selected cluster before calling the same handlers; it is not a generic proxy into account APIs. Membership uses the latest verified snapshot already installed on EC2; offline member laptops do not invalidate enrollment. A missing/invalid snapshot blocks admission. Received departures immediately invalidate subsequent access. Show snapshot revision in diagnostics; do not claim revocation propagation during a network partition.
- [ ] Run the access suite plus `test/social-core.test.ts`, `test/social-relay.test.ts`, `test/multi-cluster.test.ts`; expected all pass. Commit only this task's files as `feat: add cluster-scoped assistant teams`.

### Task 2: Six configured assistants executing on EC2

**Files:** Create `src/assistant-teams/runtime.ts`, `test/assistant-teams-runtime.test.ts`. Modify `src/personal-assistants.ts`, `src/server/routes/personal-assistants.ts`, `src/server/routes/assistant-resources.ts`, `src/assistant-resources.ts`, and team routes only where shared configuration/execution requires it.

**Interfaces:** `initializeTeamAgents(team: AssistantTeam): Promise<TeamAgent[]>`; `runTeamTurn(input: { assignment: TeamAssignment; message: string }): Promise<{ text: string; conversationId: string }>`; `teamConversation(projectId: string, conversationId: string): Promise<{ teamId: string; role: TeamRole } | null>`.

- [ ] Write tests: initialization produces exactly six stable configurations, no duplicates on retry; each assistant's prompt/model/skills are independent; EC2 is the execution node; the real initiating member is attributed; private transcripts/resources are absent; wrong execution node fails rather than migrates. Seed valid assignment records through Task 1's store. Stub agent turns, not the access checks.
- [ ] Run `npm run test:file -- test/assistant-teams-runtime.test.ts`; verify red.
- [ ] Create new empty source topics for the team under the dedicated project and local executor account. Seed concise editable role instructions, not a product workflow hardcoded into prompts. Add server-only `team` context to execution options, validated against the live assignment. Reuse source/topic/resource operations after team access is checked, without making `getPersonalAssistant` globally public. Prevent team source-history lookup from reading any owner-private conversation. Team turns use assigned subject destinations rather than re-running private topic classification.
- [ ] Add team-scoped agent/resource routes that call the extracted existing operations after access checks. Initially attach no personal secrets or browser profiles. Resource views expose team-configured resources and authorized attachable choices, never the executor account's unrelated private inventory. MCP/browser login values stay local on EC2. Enable only configured skills for the role; do not inherit machine resources accidentally. Existing secret management stays in its normal UI.
- [ ] Run the new suite plus `test/personal-assistants-api.test.ts`, `test/assistant-resources-api.test.ts`, `test/assistant-collaboration-ask.test.ts`; expected pass and private webhook/shared-project restrictions still asserted. Commit `feat: run team specialists on their host`.

### Task 3: Telegram enrollment and explicit group binding

**Files:** Create `src/assistant-teams/telegram-store.ts`, `telegram.ts`, `src/server/routes/assistant-team-telegram.ts`, `test/assistant-team-telegram-enrollment.test.ts`. Modify `src/server.ts` and existing bot-token-in-use checks in `src/assistant-telegram.ts`, `src/control-center/telegram-store.ts` as needed to prevent one bot being attached twice.

**Interfaces:** `issueTeamEnrollment(member: TeamMember): Promise<{ id: string; link: string; expiresAt: string }>`; `redeemTeamEnrollment(code: string, telegramUser: { id: string; name: string }): Promise<void>`; `confirmTeamEnrollment(member: TeamMember, enrollmentId: string): Promise<void>`; `authorizeTeamTelegram(teamId: string, chatId: string, telegramUserId: string): Promise<TeamMember>`.

- [ ] Write tests: 10-minute expiry, single redemption, competing redemption, confirmation by wrong account, forwarded link, removed member, bot-token reuse, forged webhook, unbound group and unenrolled sender. Assert zero model, agent and memory calls for refusal cases.
- [ ] Run `npm run test:file -- test/assistant-team-telegram-enrollment.test.ts`; verify red.
- [ ] Store hashed random enrollment/group-challenge tokens with expiry and transactionally consumed state. Redemption only creates pending binding; authenticated same-account confirmation activates it. Replacing a Telegram identity requires explicit new enrollment and invalidates the prior one. Store bot tokens through existing secrets facilities, not in text settings or agent environment.
- [ ] Implement member configuration endpoints under `/api/assistant-teams/:id/telegram` and a separate signed-secret-validated webhook endpoint. Keep personal Bob's group refusal unchanged. Group binding requires both a valid one-time challenge and member confirmation. Private bot messages handle enrollment only. Reuse existing Telegram HTTP adapter, token redaction and getMe readiness fields; outside group messages must not enter context.
- [ ] Run this suite plus `test/control-center-telegram.test.ts`, `test/assistant-telegram-access.test.ts`, `test/assistant-telegram.test.ts`; expected pass. Commit `feat: enroll team Telegram members`.

### Task 4: Durable group context and direct specialist addressing

**Files:** Create `src/assistant-teams/conversations.ts`, `test/assistant-team-context.test.ts`. Modify team Telegram store/handler and minimally extract common media normalization from `src/server/telegram.ts` if necessary.

**Interfaces:** `ingestTeamTelegramUpdate(teamId: string, update: unknown): Promise<{ message: TeamMessage; duplicate: boolean } | null>`; `directTeamTargets(message: TeamMessage): Promise<TeamRole[]>`; `teamSubjectCandidates(teamId: string, message: TeamMessage): Promise<TeamSubject[]>`; `bindTeamConversation(teamId: string, subjectId: string, assistantId: string, conversationId: string): Promise<void>`.

- [ ] Write tests: store full text over 2,000 characters and beyond 200 messages; repeated update changes nothing; edits preserve versions but never retrigger accepted work; two humans' interleaved subjects stay separate; forum topics and reply IDs are preserved. Pin commands, aliases, bot mention, replies to specialist results, unknown aliases and multiple explicit targets. Quoted/code mentions and other bots do not trigger work.
- [ ] Run `npm run test:file -- test/assistant-team-context.test.ts`; verify red.
- [ ] Persist authorized inbox events before returning webhook success. Add full message/edit history and subject/per-agent conversation maps. Mark bot-authored messages as outputs, never fresh monitoring input. Keep the event state durable until decision or failure; restart cannot lose an event merely because its update ID was deduplicated.
- [ ] Reuse current photo/file/album/voice parsing and local attachment storage, preserving original references plus extracted text. Apply existing size/transcription limits and report unsupported content. Preserve Telegram thread/reply fields through outbound work. Retrieve bounded relevant history and summaries without deleting original records. Reply lookup uses stored sent Telegram IDs; no guessed ID such as `-Date.now()`.
- [ ] Run the new suite plus `test/webhook-telegram.test.ts`, `test/assistant-telegram-access.test.ts`; expected pass. Commit `feat: preserve team Telegram context`.

### Task 5: Central decision policy and subject routing

**Files:** Create `src/assistant-teams/questions.ts`, `decisions.ts`, `test/assistant-team-decisions.test.ts`. Modify team conversations and route input validation.

**Interfaces:** `proactiveDisposition(choice: "act" | "none", confidence: number, settings: TeamSettings): "act" | "ask" | "silent"`; `decideTeamMessage(team: AssistantTeam, message: TeamMessage): Promise<{ attention: "act" | "ask" | "silent" | "direct"; targets: TeamRole[]; route: TeamRoute; learn: boolean } | null>`. A `clarify` topic outcome is not `new`; direct calls have no extra confidence threshold for topic selection.

- [ ] Write the boundary test below, plus invalid setting/range/NaN cases, `none` at 0.99, different central versus personal model selections, direct `/qa` at low attention confidence, and failed decision returning no dispatch. Test that known reply IDs bypass semantic subject guessing, and candidates never include another team's or personal topics.

```ts
const defaults = { askThreshold: 0.80, actThreshold: 0.95 };
assert.equal(proactiveDisposition("act", 0.96, defaults), "act");
assert.equal(proactiveDisposition("act", 0.95, defaults), "ask");
assert.equal(proactiveDisposition("act", 0.81, defaults), "ask");
assert.equal(proactiveDisposition("act", 0.80, defaults), "silent");
assert.equal(proactiveDisposition("none", 0.99, defaults), "silent");
assert.equal(proactiveDisposition("act", 0.91, { askThreshold: 0.70, actThreshold: 0.90 }), "act");
```

- [ ] Run `npm run test:file -- test/assistant-team-decisions.test.ts`; verify red.
- [ ] Build Choice questions through existing `askSystemOneChoices`, with bounded team-only evidence and explicit `none`/`new` candidates. Use `systemAiSettings().decision.model`, `systemDecisionKey(model)`, `decisionModelTarget(model, key)`. Batch independent attention, subject and durable-memory judgments sharing evidence. Keep attention confidence distinct from target/subject selection. Explicit aliases select roles in code; an unclear topic asks clarification rather than granting a new automatic action. Null/malformed decision never falls back to Bob's executing model. If modifying the provider protocol itself, fetch the live TypeSafe API/Choice docs first; this plan requires no new SDK or protocol fields.
- [ ] Persist the selected model/target, raw returned choice/confidence, settings revision, evidence message IDs and disposition. Direct requests are accepted/acknowledged independently of attention classification; unresolved subject selection remains waiting with a clear reason. Model failure is visible, never disguised as silence or success.
- [ ] Run the new suite plus `test/control-center-decisions.test.ts`, `test/system-ai-credentials.test.ts`, `test/decision-network-guard.test.ts`; expected pass. Commit `feat: route team work with decision thresholds`.

### Task 6: Assignments, private delegation and public delivery

**Files:** Create `src/assistant-teams/assignments.ts`, `tools.ts`, `delivery.ts`, `test/assistant-team-assignments.test.ts`. Modify team runtime, Telegram handlers and `src/assistant-collaboration/bridge-tools.ts` only to register the dedicated team tool set.

**Interfaces:** `acceptTeamAssignment(member: TeamMember, message: TeamMessage, roles: TeamRole[], subjectId: string | null): Promise<TeamAssignment[]>`; `routeTeamAssignment(assignmentId: string, route: TeamRoute): Promise<void>`; `confirmTeamInquiry(member: TeamMember, inquiryId: string, decision: "confirm" | "dismiss"): Promise<void>`; `delegateTeamAssignment(parentId: string, role: Exclude<TeamRole, "bob">, message: string): Promise<TeamAssignment>`; `publishTeamResult(assignmentId: string): Promise<void>`; `recoverTeamWork(teamId: string): Promise<void>`.

- [ ] Write tests: direct QA gets one Bob acknowledgment followed by labelled QA result; delegated QA has zero direct Telegram sends; Bob reads its child result and publishes the root answer; multi-target direct calls get one acknowledgment and distinct labelled results. A 90% inquiry dispatches nothing until a current member confirms; duplicate/revoked confirmations do nothing. Explicit reply "yes" binds to its inquiry; unrelated "yes" cannot approve it.
- [ ] Add crash tests at inbox claim, enqueue, dispatch, child completion, acknowledgment send and final send. Stable root/request/outbox keys prevent duplicate assignments. A result arriving after another request retains its original chat/thread/reply target. A Telegram send timeout with unknown outcome becomes uncertain; no automatic resend. A known completed child survives restart.
- [ ] Run `npm run test:file -- test/assistant-team-assignments.test.ts`; verify red.
- [ ] Implement transactional assignment and inquiry records. Explicit calls create accepted records with a nullable subject before semantic routing, so Bob can acknowledge immediately. `routeTeamAssignment` creates/binds a subject on `new`/`continue`; `clarify` or decision failure leaves it waiting. Dispatch requires a resolved subject. Acknowledge only durable acceptance; record queue-versus-running wording accurately. Hold final publication until the acknowledgment has a confirmed receipt; uncertain acknowledgment delivery is shown for reconciliation, not blindly resent. Dispatch at most one turn per assistant conversation through existing queue machinery. Before public output, resolve destination from the stored assignment, never from agent-provided chat IDs. Save actual Telegram receipt IDs for future replies. Use one root idempotency key per source event and destination child role.
- [ ] Add `team_list_agents`, `team_delegate`, `team_read_assignment` tools to Bob's active team turns only. Bind every call to the running root and member. Specialists have no delegation tool; generic owner-private helper tools stay unavailable in team turns. Persist and wake Bob on completed children; resume through the existing runtime instead of an in-memory promise alone. Bound delegated turns to ten per root, then request human continuation. Inquiries and existing work for the same subject/request are updated, not duplicated.
- [ ] Implement startup/event-driven recovery: resume queued undispatched work, reconcile dispatched work by persisted runtime request IDs/receipts, mark unknown effects uncertain. Apply Telegram retry-after only to definite rejection, not unknown delivery. Record output steps separately so recovery never reruns an agent solely to retry delivery.
- [ ] Run the new suite plus `test/assistant-collaboration-ask.test.ts`, `test/control-center-assistants.test.ts`; expected pass. Commit `feat: coordinate team assignments and replies`.

### Task 7: Preserve human decisions and stop autonomous specialist loops

**Files:** Create `test/assistant-team-safety.test.ts`. Modify `src/assistant-teams/runtime.ts`, `assignments.ts`, `src/server/control-center-review-check.ts`, `src/control-center/auto-respond.ts`, `src/guardian/reviews.ts`, `src/guardian/production-rule.ts`, and team routes only at actual integration boundaries.

**Interfaces:** `resolveTeamApproval(member: TeamMember, assignmentId: string, reviewId: string, allow: boolean): Promise<void>` in `assignments.ts`; consume `teamConversation` from Task 2.

- [ ] Write tests: team specialists never receive generic Auto respond or personal unfinished-work nudges, even if executor preferences enable them; Bob explicitly continuing a child is recorded as delegation. Confidence 0.99 cannot approve a Guardian review. Any current member can answer a team review, outsider/removed member cannot; repeated approval cannot execute twice. Agent-origin text cannot impersonate a human confirmation.
- [ ] Run `npm run test:file -- test/assistant-team-safety.test.ts`; verify red.
- [ ] Add narrow team checks to turn scheduling and personal nudges. Keep a stopped specialist's clarification waiting for the human or Bob's explicit next assignment. Bind Guardian reviews to the actual team conversation, initiating actor and exact operation; team approval authenticates the real approving member and preserves the existing review state machine. Do not invoke owner endpoints with forged account/session identities. Require the production guard for production-capable team work; missing guard means visible blocked readiness, not silent unguarded execution.
- [ ] Recheck current membership before dispatch, tool delegation, confirmation and publication; record cancellation/refusal for work not yet dispatched after removal. An effect dispatched while access was valid is not magically reversible; never claim otherwise.
- [ ] Run the new suite plus `test/guardian.test.ts`, `test/guardian-agents.test.ts`, `test/control-center-decisions.test.ts`; expected pass. Commit `fix: enforce team execution boundaries`.

### Task 8: Shared filesystem subject memory

**Files:** Create `src/assistant-teams/memory.ts`, `test/assistant-team-memory.test.ts`. Modify team store/runtime/routes, and `src/control-center/memory-store.ts` only for narrow reuse of existing file/index helpers if needed.

**Interfaces:** `teamMemoryRoot(teamId: string): string`; `learnTeamMessage(teamId: string, messageId: string): Promise<void>`; `readTeamMemory(teamId: string, subjectId: string): Promise<string>`; `writeTeamMemory(member: TeamMember, input: { topic: string; expectedRevision: number; description: string; body: string; sourceMessageIds: string[] }): Promise<{ revision: number }>`.

- [ ] Write tests: a durable human decision is learned without Telegram output or a specialist turn; casual chat creates no subject file; a proposal stays labelled a proposal; source account/message links remain; cross-topic links and index work; private personal memory is absent; outsider text is never learned. Two writes from the same old revision cannot both win. Revert preserves newer edits by conflict reporting rather than overwriting them.
- [ ] Add file/DB crash tests: committed change with a missing file application regenerates the file/index on startup without another model call; an incomplete temp file never replaces a good topic. Team changes never enter personal twin-memory replication.
- [ ] Run `npm run test:file -- test/assistant-team-memory.test.ts`; verify red.
- [ ] Use `<data>/assistant-teams/<team-id>/memory/INDEX.md` and topic Markdown files; reuse pure `cleanTopic`, `topicText`, `parseTopic`, `topicLinks`, `applyTopicText` helpers. Add team-scoped change revisions and a committed-write journal so replay writes files, not repeats inference. One writer serializes learning and applies revisions. Classify with the selected system decision model; use the configured system knowledge writer only to compose text after that judgment. If it is unavailable, show memory waiting/unavailable, not a hidden fallback. Do not truncate source history when bounding learning context.
- [ ] Supply scoped memory read/write tools to team turns and add paged topic/change APIs. Specialist memory suggestions go through the same writer; their prompts cannot bypass revisions. Link subject conversations and evidence, and store unresolved disagreements rather than selecting a fictional consensus.
- [ ] Run the new suite plus `test/control-center-memory-store.test.ts`, `test/control-center-memory.test.ts`, `test/assistant-resources.test.ts`; expected pass. Commit `feat: keep shared team subject memory`.

### Task 9: Control-center team settings, enrollment and activity

**Files:** Create `public/app/control-team.js`, `control-team-telegram.js`, `test/ui/ui-assistant-teams.test.ts`. Modify `public/app/control-chat.js`, `control-assistants.js`, `control-memory.js`, `control-telegram.js`, `public/index.html`, `public/app/elements.js`, `public/app.js`, `public/control-center.css`, `public/sw.js` and team routes minimally. Add QR dependency to `package.json`/lock only here if required.

**Interfaces:** Team API extends Task 1 with `/agents`, `/assignments`, `/messages`, `/memory/topics`, `/memory/changes`, `/events`; configuration mutations require `expectedRevision`. Telegram subroutes from Task 3 expose readiness, create/pending/confirm enrollment and group binding. Events carry team IDs and changed entity IDs; handlers reauthorize before reading content.

- [ ] Write browser tests using isolated seeded nodes: two members see the same six cards and changes; edit distinct prompts/models/resources; set ask 80/act 95, reject reversed/equal settings, refresh and retain values. Decode the generated QR and assert it equals the enrollment URL, with no bot token in DOM, network response or log. Complete the simulated pending-confirm flow; test expired link and outsider rejection.
- [ ] Add journeys for accepted/queued/running/needs-human/uncertain work, direct versus delegated results, linked conversation access, paged memory edit/revert and decision failures. Verify no duplicate permission matrix or independent team classifier selector. New controls have `data-testid`, mobile usability and height-fitting paginated lists.
- [ ] Run `npm run test:file -- test/ui/ui-assistant-teams.test.ts`; verify red. Native browser launch is allowed only through `test/dev-nodes.ts`/`test/ui/launch-chrome.ts`, disposable profiles and loopback fixtures; clean up in teardown.
- [ ] Add the team context to existing control-center tabs/settings. Personal Bob remains separate and unchanged. Show the host as EC2, actual decision readiness, Telegram full-group visibility, enrolled identities and bound group. Reuse configuration widgets and memory views, not duplicate product screens. No remote QR generator. Use event-driven updates; remote members access EC2 over existing signed relay transport or its authenticated page.
- [ ] Bump the service-worker cache version and its pinned tests when shell assets change. Run the new journey plus `test/ui/ui-control-assistants.test.ts`, `test/ui/ui-control-memory.test.ts`, `test/ui/ui-control-telegram.test.ts`, `test/ui/ui-personal-assistant.test.ts`; expected pass. Commit `feat: configure and inspect assistant teams`.

### Task 10: Integrated verification and EC2 deployment procedure

**Files:** Create `test/assistant-teams-integration.test.ts`, `docs/assistant-teams.md`. Update `docs/assistants.md`, `docs/control-center.md`, `README.md` and release notes for the implemented feature only.

**Interfaces:** Exercise real team routes, synthetic Telegram HTTP fixtures, isolated non-twin cluster membership, stubbed decision/agent providers, and normal runtime receipt storage. No production account data.

- [ ] Write an end-to-end test with two members and a same-relay outsider: enrollment → group binding → quiet discussion → threshold inquiry → confirmation → Bob acknowledgment → specialist delegation → internal result → Bob's public result → direct QA call → follow-up from the second person → subject memory. Assert exact recipients, conversation IDs, sources and agent counts.
- [ ] Add restart/replay cases at Task 6's dispatch/send boundaries and an offline-home-node case after enrollment. Test changed membership, malformed callbacks, invalid thresholds, parallel discussions, late output, long text, album/voice metadata, model outage and no local runtime. Map every R1–R10 and all ten spec acceptance cases to a named test.
- [ ] Run `npm run test:file -- test/assistant-teams-integration.test.ts` until pass, then `npm run typecheck`, `npm test`, `npm run build`, `npm run test:ui`. Record failing baselines honestly; no passing claim from a focused suite when full gates fail. No live Telegram bot or paid decision requests during automated tests.
- [ ] Write the operator procedure: identify and verify the actual Contigos EC2/AWS account and cluster; check Ubuntu/service, disk/RAM/CPU, runtime/provider readiness, persistent storage, HTTPS webhook ingress and ability to keep normal relay traffic responsive. Benchmark the representative coordination fixture before choosing any instance resize. No new EC2 instance, security-group opening or infrastructure change is implied.
- [ ] Document release deployment through existing installer/update lifecycle, node-local provider/MCP/browser sign-in, dedicated shared project, six roles, bot setup, group visibility, QR/link onboarding and backup/restore of SQLite plus team memory/transcripts. Keep provider credentials out of exported memory, transcripts and deployment logs. Establish a verified backup before schema upgrade; rollback disables team reception/work without discarding history or replaying uncertain effects.
- [ ] After implementation approval and operator credentials are available, deploy the tested release to the verified Contigos host. Connect the real bot, have the user and Ido complete identity confirmation, and verify direct calls, both thresholds, delegation, memory and restart with both laptops offline. Human sign-ins and unsafe operations require their real approvals. Record actual receipts/status rather than claiming that synthetic tests prove production works.
- [ ] Commit verified code/docs changes as an atomic Conventional Commit. Deployment is a later authorized operation, not something performed by this planning turn.

## Coverage map

| Requirement | Primary tasks |
| --- | --- |
| R1 Individual six-agent configuration | 1, 2, 9 |
| R2 Always-on EC2 execution | 2, 6, 10 |
| R3 Cluster-wide access, reject outsiders | 1, 3, 7, 10 |
| R4 QR/link enrollment | 3, 9 |
| R5 Only Bob monitors, central decision model | 4, 5, 7 |
| R6 Two configurable thresholds | 5, 9 |
| R7 Explicit calls and acknowledgment | 4, 5, 6 |
| R8 One Telegram account, distinct reply destinations | 3, 6 |
| R9 Coordination without independent specialist responses | 6, 7 |
| R10 Conversation continuity and subject files | 4, 5, 8 |

## Planning review and status

- Code/docs inspection completed; no production EC2/Telegram readiness claims.
- All implementation boxes intentionally unchecked. Product code and deployment have not changed.
- Document verification passed: linked files exist, code fences balance, no trailing whitespace, ten ordered tasks, R1–R10 coverage and no implementation marked complete.
- Self-review checked requirement coverage, interface names/types, task dependencies, threshold boundaries, member identity, reply destinations and restart behavior. Corrections included cluster-bound actors, nullable subjects before direct-call routing and no replay of uncertain acknowledgments.
- Independent builder review was attempted through a read-only worker. It returned no review because its configured `gpt-5.5` model was unsupported by that worker's Codex account. The dashboard's success label was not treated as a completed review. No independent approval is claimed.
- No remaining product question blocks planning. Runtime choice per role, exact prompts/skills and real credentials are deployment configuration, not invented during this task.
