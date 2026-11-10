# Contigos Telegram assistant team

Status: requirements agreed in conversation. Implementation, testing, commit and push were subsequently authorized by the user. Implementation and isolated verification are documented in [operator reference](../../assistant-teams.md); live Contigos deployment, bot setup and member enrollment are not claimed here.

Date: 2026-11-09
Code baseline: `main` at `7015d453`, verified with `git pull --ff-only origin main`.
Plan: [implementation plan](../plans/2026-11-09-contigos-telegram-team.md).

## Intent

Give the Contigos team one always-available Bob coordinator and five specialist assistants through one Telegram bot account and Joint Bob's control center. The user and Ido can discuss work naturally, address specialists, and let Bob coordinate work without either laptop running. Preserve the discussion, task context and durable subject knowledge on the Contigos relay EC2.

## Confirmed requirements

| ID | Requirement |
| --- | --- |
| R1 | Six agents: Bob, Product, Designer, QA, PR reviewer and Technical Support. Each has its own instructions, skills and other execution resources. |
| R2 | All agents execute on the Contigos relay EC2. The receiver and coordinator stay available without an open browser or connected laptop. |
| R3 | The entire Contigos cluster can use the team. No per-person or per-agent permission matrix. Requests from outsiders fail before models or agents run. |
| R4 | Telegram configuration onboards members using a QR code or link. Membership in a Telegram group alone is not authorization. |
| R5 | Only Bob monitors general discussion. Semantic decisions use the decision model selected in AI settings. |
| R6 | For unsolicited monitoring: confidence above 95% starts work; above 80% through 95% asks whether to check; 80% or below stays silent. Both thresholds are configurable in Bob's control-center settings. |
| R7 | Explicit human calls start without the proactive confidence gate. Bob acknowledges that it accepted the assignment. |
| R8 | A directly called specialist replies to the group through the same Telegram account, labelled with its specialist name. A specialist called by Bob replies only to Bob. |
| R9 | Bob coordinates assignments and results. Specialists never independently monitor, auto-respond or start chains of calls. |
| R10 | Choose new versus continued conversations and keep their context. Save durable memory as a subject map on the filesystem. |

## Current implementation and gaps

The following were checked in code, not inferred from old design documents.

- `src/control-center/telegram-updates.ts`: control-center Bob serves one linked person in a private chat and leaves groups. `test/control-center-telegram.test.ts` pins that behavior. Preserve it for personal Bob.
- `src/server/telegram.ts`, `src/assistant-telegram.ts`: assistant bots already accept approved groups, handle attachments and voice, judge whether to answer, and scope topic routing by chat. They retain 200 group messages, truncate text to 2,000 characters, and supply the last 20 as context. This is not a durable team transcript.
- `src/personal-assistants.ts`, `src/server/routes/personal-assistants.ts`: individual instructions, execution settings, source conversations, turn records and topic routing exist. Owner identity and source-history assumptions require a team-aware path.
- `src/assistant-resources.ts`, `src/server/routes/assistant-resources.ts`: skills, plugins, MCP selection, files, memory and browser profiles attach to assistants, but resource APIs authorize the owner.
- `src/assistant-collaboration/ask.ts`: only owner chat and scheduled turns can ask helpers; webhook turns and shared projects are refused; helper turns cannot recurse. Do not remove those protections globally.
- `src/control-center/assistants.ts`: Bob selects helpers mostly by resources, gathers answers and supplies them before answering. This is not a durable sequence of role assignments.
- `src/control-center/decisions.ts`: personal Bob has a single confidence threshold and agent fallback. The team needs two explicit thresholds, no executing-agent fallback, and separate attention versus topic decisions.
- `src/control-center/memory-store.ts`, `memory.ts`: Markdown subjects, index, links, changes and read history exist, scoped to a person. Learning currently observes Bob exchanges, not silent group discussion.
- `src/system-ai-config.ts`, `src/system-ai.ts`: central decision model and server-only credential resolution exist. Older Bob/assistant routes still select their own classifiers and project credentials.
- `src/auth.ts`, `src/accounts.ts`, `src/cluster-membership.ts`, `src/social/directory.ts`: authenticated accounts, visitor cluster claims, signed machine membership and home identity verification exist. A relay connection alone does not establish the requested team's boundary.

## Implementation choices

These are engineering defaults, not additional requirements attributed to the user.

### Team scope and hosting

Create one cluster-scoped team record with an EC2 host, a dedicated shared project and six newly created assistant configurations. Reuse the normal assistant runtime and resource records. Do not convert an existing personal assistant or inherit a personal source transcript, memory, secret account or browser profile.

A local EC2 account supplies the existing runtime/resource ownership needed by Joint Bob. The server resolves that execution identity during setup; request bodies cannot nominate arbitrary accounts to impersonate. It is an execution identity, not the authority of a Telegram sender. Preserve the actual human identity and originating message separately on every assignment. All team members have the same team configuration, chat, history and memory access. Existing node administration and secret-value controls remain unchanged; team membership does not make someone an EC2 administrator or export credentials.

A team-specific authorization layer checks the selected cluster, never merely the relay or the project name. Use existing authenticated sessions and signed home identity assertions. Persist established Telegram identity bindings on EC2; an enrolled person's home laptop need not be online for every message. Apply received membership changes before admitting more work. Use the latest verified membership snapshot installed on EC2. A missing, invalid or closed-cluster snapshot blocks new work; an offline member laptop does not. Show the snapshot revision in diagnostics and do not claim instantaneous knowledge of remote revocation during a network partition.

The shared team record is not a fake personal account. Private assistant APIs and owner-only collaboration retain their current checks. Team-specific entry points first authenticate the member, then invoke server-owned execution with explicit team context. The EC2 has all required code, runtimes, provider access and browser profiles locally. No fallback to a laptop or another node.

### Telegram enrollment and group binding

In team Telegram configuration, a signed-in member chooses **Connect Telegram**. Create a random single-use link and QR code, valid for ten minutes. Store only the token hash. Redemption in a private bot chat identifies a pending Telegram user; confirmation by the same authenticated Joint Bob account completes the binding. Display the Telegram identity being confirmed. A forwarded link is not enough to join the team.

Bind an existing private Telegram group to this team through an authenticated team configuration action and a one-time bot group challenge. Only explicitly bound groups are accepted. Do not grant access merely because someone added the bot. Outside private messages and messages from unenrolled/removed participants run no decision, memory update or agent; they do not become team context. A valid Telegram webhook secret proves delivery origin, not member authorization.

Only registered groups carry work. Private bot chats perform enrollment and show setup guidance, not a second private team assistant history. The bot must receive whole-group messages: guide the operator through Telegram privacy mode or admin setup and show readiness. Missing visibility is a setup failure, not a healthy monitoring state.

Telegram membership controls who can see messages already posted in Telegram. Joint Bob rejects outside requests, but cannot hide group replies from someone a human admits to that Telegram group or erase delivered history. State this during setup; do not promise an app permission check is a Telegram confidentiality boundary.

### Direct addressing and acknowledgment

Offer fixed, documented logical aliases through the single bot: `/bob`, `/product`, `/designer`, `/qa`, `/pr_reviewer`, `/support`; accept leading `@bob`, `@product`, `@designer`, `@qa`, `@pr_reviewer`, `@support` as application aliases too. These aliases are not separate native Telegram accounts. Mentioning the connected bot targets Bob. Replies to a recorded specialist answer continue that specialist's conversation; replies to Bob's acknowledgment continue the associated assignment. Resolve targets from message entities and actual stored reply IDs, not quoted text or substrings inside documents/code.

An explicit call bypasses attention thresholds, not identity, execution readiness, topic validation or existing safety gates. After recording the assignment durably, Bob sends an acknowledgment such as **Taken. QA is checking this.** For queued work say **Taken. QA is queued.** Never claim a failed enqueue was accepted. Record one acknowledgment per assignment. Unknown aliases or missing work get a clarification, not an invented assignment. Multiple explicit specialists receive one root assignment, one acknowledgment naming them, and one labelled result per requested specialist.

### Proactive decisions

Ask whether the discussion warrants Bob taking action, with `act` and `none` as explicit outcomes. A highly confident `none` remains silent. Apply thresholds to the confidence of an affirmative `act` judgment, not to arbitrary model confidence:

| Result | Behavior |
| --- | --- |
| `act` with confidence > 0.95 | Persist assignment, acknowledge in Telegram, dispatch Bob. |
| `act` with 0.80 < confidence <= 0.95 | Post **Should I check this?** with Confirm and Dismiss; dispatch nothing. |
| `act` with confidence <= 0.80, or `none` | Keep authorized discussion history; no unsolicited reply or assignment. |
| Missing, invalid or failed decision | Record visible decision failure; dispatch nothing. No fallback to Bob's agent. |

Store `askThreshold = 0.80`, `actThreshold = 0.95`; validate `0 <= askThreshold < actThreshold <= 1`. Show percentages in **Bob control center → Settings → Team monitoring** and apply them team-wide on EC2. The central AI decision model is displayed with a link to AI settings, not another classifier selector.

Any current enrolled team member may confirm or dismiss an inquiry. Confirmation is tied to the exact pending request and succeeds once. A reply such as "yes" is accepted without a new semantic interpretation only when it explicitly replies to that question; a loose "yes" in a busy group requires clarification. Recheck membership and readiness before starting. At most one open inquiry or active assignment for the same routed request; new evidence attaches to that request rather than producing repeated invitations to check it.

### Conversations and coordination

Persist full authorized Telegram messages with sender account and Telegram IDs, chat/topic IDs, message/edit IDs, timestamps, reply links and attachment references. Store the original text, not the shortened model view. Match repeated deliveries by update ID and messages by chat/message identity. Edits update context with revision history; they never silently rerun already-dispatched work. Telegram does not provide a complete deletion feed, so do not promise automatic deletion mirroring.

Route only among this team's conversation summaries and relevant memory, preserving group/forum-topic context. Direct reply relationships take precedence over semantic guesses. Distinct subjects keep separate conversations; a follow-up returns to the prior conversation even if another participant sends it. Resuming must preserve each specialist's identity and settings. A team subject can link several agent conversations; do not switch personas inside a single agent transcript.

Persist assignments, parents, selected agent, source conversation, destination and outcomes. Bob can assign a specialist, consume the answer, request a revision or assign the next specialist. All specialist calls return internally; the server publishes a directly requested specialist's final result to Telegram, while Bob owns the public result for Bob-initiated work. Destination is trusted metadata, never an agent's text instruction.

Existing Auto respond and personal Bob's unfinished-work nudges are off for team specialist conversations. Bob may explicitly continue a child assignment; that is tracked coordination, not a generic auto-response engine. Human decisions and Guardian approvals cannot be answered by Bob. Bound automatic coordination to ten delegated turns per root assignment initially; exhausting that bound asks the team to continue. This is a fixed safety bound, not a new settings panel.

### History and filesystem memory

Keep the durable message/task ledger in SQLite and agent transcripts in the normal conversation store. Keep memory in `<data>/assistant-teams/<team-id>/memory/`, with `INDEX.md`, subject Markdown files and `[[subject-links]]`. The memory map is the index and links; no graph database or separate graph visualization is required.

All team agents read the shared subject memory plus their own configured role notes. One team memory writer serializes changes. Learn durable facts, agreed decisions, corrections and unresolved questions from authorized discussion even when Bob remains silent. This bookkeeping must not start a specialist or post unsolicited chat messages. Classify proposals as proposals, preserve who said what, and link memory changes to source messages and conversations. Do not turn an unverified claim into a team decision or save secret values.

Reuse existing atomic file writes, index/link handling and memory change review. Separate team change records from personal account history and personal twin replication. Review/Edit/Revert stays available to all team members. Topic writes use revisions so stale edits cannot silently overwrite newer facts. A low attention confidence does not delete history; conversation context and durable memory are separate concerns.

### Availability and failure behavior

The receiver, durable queue and coordinator run under the existing Linux service lifecycle, not inside a browser or user conversation. Six configured agents do not mean six continuously running model sessions. Wake on accepted messages, completed children, confirmations and startup recovery. Reuse existing event delivery; do not introduce cluster polling loops.

Persist inbox acceptance before acknowledging Telegram delivery. Resume queued, undispatched work after restart. Reconcile running work against runtime receipts; an unknown external effect or unknown Telegram send result is **Uncertain**, not blindly retried. Known completed child results remain available for Bob to resume coordination. Per-agent queues prevent two turns from mutating the same conversation concurrently.

Control center shows receiver readiness, decision failures, queued/running/waiting/failed/uncertain assignments, and actual delivery status. Surface errors to the originating group when a direct request cannot proceed, without leaking tokens. Keep Telegram provider rate-limit handling and file limits from existing code. A silent proactive outcome is not a service failure.

Production/destructive actions remain subject to existing Guardian/human approvals. "Above 95%" authorizes picking up the assignment, not bypassing those controls. Team members share the same approval rights where the existing gate permits; extend the gate with verified team-member checks rather than fabricating owner identity. The initial deployment is blocked if that gate cannot safely represent the real approver.

## Scope and delivery

Implement shared scope/runtime first, then Telegram ingestion, decision and conversation routing, coordination and reply delivery, memory, and control-center configuration. Test each stage with isolated fixtures before a full two-member journey.

No new public assistant marketplace, per-agent ACL editor, separate specialist bots, multi-host execution, automatic failover, new graph engine, or replacement of personal Bob. Voice/files reuse existing Telegram support; no new media pipeline.

The later deployment must identify the actual Contigos EC2 instance and cluster, verify capacity and local runtimes, install the release, attach authorized team resources, connect the bot, enroll the user and Ido, and test with both laptops offline. Capacity, credentials and live delivery were not inspected in this planning task. Do not choose a different AWS account or create infrastructure without verification.

## Acceptance

1. Both members see and configure the same six agents, history, assignments and memory. Another cluster on the same relay cannot access them.
2. Enrollment links/QRs expire, redeem once, and require authenticated confirmation. Spoofed identities, forwarded links and removed members cannot start work.
3. Affirmative confidence 0.96 acts, 0.95 asks, 0.81 asks, 0.80 stays silent; `none` at 0.99 stays silent. Settings change the boundaries and survive restart.
4. `/qa` runs without the proactive threshold and gets Bob's acknowledgment before its labelled result. A Bob-delegated QA answer never posts itself to Telegram.
5. A follow-up from the other person resumes the correct subject. A simultaneous unrelated discussion starts another conversation. No personal assistant history enters either.
6. Bob coordinates Product → Designer → QA → PR reviewer as a test workflow, without specialists recursively calling each other or generic auto-response nudges.
7. An unaddressed durable decision can enter subject memory without a Telegram reply or specialist run. Sources, edits, linked subjects and revert are preserved.
8. Repeated updates, repeated confirmations, restart and connection loss do not duplicate assignments or replay uncertain external effects. A delayed result stays with its original request.
9. The EC2 handles Telegram and agents with both laptops offline. An unavailable decision model or runtime is visible and does not cause laptop fallback.
10. Existing private Bob, personal assistants, social groups and owner-only collaboration retain their behavior.

## Review status

The implemented feature received fresh-context reviews. Regressions now cover signed membership/account revocation, live transcript detachment, selected-cluster project scope, exact-request coalescing, relevant execution context and paginated UI. Isolated real HTTP, queue, Pi/tool and Telegram fixtures exercise the coordination journey and restart with an enrolled member's home stopped. Native assertions passed; the complete UI gate remains incomplete with failures and timeouts. See the operator reference for exact supported resources, verification limits and the separate production acceptance procedure.
