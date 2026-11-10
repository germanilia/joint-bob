# Cluster assistant teams

One host runs Bob, Product, Designer, QA, PR reviewer and Technical Support in a new shared project. Personal Bob and personal assistants remain separate. The six roles are configurations, not six permanently running models.

## Operation and boundaries

- Select the team in the existing control center. Each role has independent instructions, Pi model/effort and uploaded skills/files. Team monitoring thresholds are team-wide: affirmative confidence **>95% acts**, **>80% through 95% asks**, otherwise silent. A confident `none` is silent. The central AI decision setting is authoritative; there is no agent fallback.
- Supported runtime and knowledge writer: **Pi only**. Other harnesses are not silently substituted. Each role's resources are its uploaded skills/files plus what the host shares with the team and the role selects:
  - **MCP:** only the host execution account, signed in on the host, can share one of its shared-connection MCP definitions. No credentials are copied. Every tool list and call rechecks the running assignment, the role selection and the share.
  - **Browser:** a new persistent profile created for the team on the host, or one explicitly shared to the team project or cluster. Logins are never copied: the first sign-in goes through the normal sign-in card and human takeover.
  - **Plugins:** only app-configured plugin directories whose contents are Pi skills. Plugins with Claude-only parts (commands, agents, hooks, MCP servers) are rejected rather than half-loaded.
  - Revoking a share takes effect on the next call. An empty inventory never falls back to the executor's private resources.
- Use `/bob`, `/product`, `/designer`, `/qa`, `/pr_reviewer`, `/support` (or leading `@` aliases) through one Telegram bot. These are logical aliases, not separate accounts. Explicit calls bypass attention confidence, never membership, readiness or Guardian approval.
- An accepted request has a durable acknowledgment. A directly requested specialist's final answer is labelled; Bob-delegated results remain internal. Bob alone delegates, with at most ten child turns per root. Persona-specific conversations remain separate even on the same subject.
- Inquiry Confirm/Dismiss buttons bind to the exact delivered question, chat and forum thread. Current enrolled members may respond once. An explicit reply `yes`/`no` also works; loose confirmation asks for clarification. Forwarded buttons or enrollment links do not confer authority.
- Authorized full messages, versions, IDs, attachments and task receipts persist. Original files and extracted content are supplied as local paths/text; no new binary/PDF understanding or native image-model input is promised. Voice uses existing transcription readiness/limits. Ten-file and 20 MiB download limits remain; unsupported extraction is reported. Albums consolidate arrivals during a short window; late parts are retained as context, not new work.
- Quiet authorized discussion may update shared Markdown memory without an agent assignment or Telegram reply. Review/edit/revert uses revision checks and source links. Original source history may contain sensitive values; derived memory and inference projections are redacted. Treat backups as sensitive.
- Membership checks use the latest verified signed snapshot installed on the host. Enrolled members' homes need not stay online. Received revocations block new work; unreceived revocations during a partition cannot be inferred.
- Telegram group participants can see delivered messages regardless of app enrollment. App authorization is **not** a Telegram confidentiality boundary.

## Failure handling

Member diagnostics (`GET /api/assistant-teams/:id/assignments`) include assignments, work, inbox claims, deliveries, approvals and sanitized recovery failures. Decision attempts and memory status have separate diagnostics. A routing outage after acceptance leaves work waiting with `decision_failed`, not an invented subject question. Pre-dispatch runtime failures are held with `runtime_unavailable` and a group explanation; no alternative host/model runs. Recovery failures are journaled as `recovery_failed` even when an event wake has no HTTP caller.

`uncertain` means an external effect may have happened. **Never delete its receipt, reset it to queued, resend it, or submit the same effect under a new ID to “repair” it.** Reconcile with actual provider/runtime/Telegram evidence first. A restart reuses confirmed receipts and rebuilds committed memory; it does not authorize uncertain replay. Unknown acknowledgment delivery prevents final output overtaking it. Known provider rejections with explicit retry-after can be retried; unknown network outcomes cannot.

## Verification matrix

These are synthetic checks, not production certification. Exact test names below are search keys. New integration file: `test/assistant-teams-integration.test.ts` (I). Existing suites retain their own fixture limitations.

| Requirement / acceptance | Named evidence | Scope / remaining qualification |
|---|---|---|
| R1 / A1 six shared roles | runtime: `six stable isolated configurations; assignment and host checks precede execution`; access: `signed non-twin membership, equal access, dedicated storage and received revocation` | Pi and uploaded resources only; UI gates owned separately |
| R2 / A9 host execution | I: `loopback Telegram HTTP → durable queue → Pi tools: four private specialists, final Bob, direct QA and restart`; I: `runtime readiness failure is durably held rather than silently queued for retry` | Actual member home stops after enrollment; disposable host represents EC2, not a live EC2 proof |
| R3 / A1,A2 outsiders | same I journey; access: `HTTP and signed peer facade authenticate the selected cluster and account, never relay proximity` | Real signed non-twin cluster and active shared relay; outsider refused |
| R4 / A2 enrollment | enrollment: `enrollment is expiring, single-use, pending until same-account confirmation; groups require confirmation`; same I journey | Real HTTP redemption/confirmation; QR/browser validation is parent-owned |
| R5 / A3 only Bob monitors | decisions: `central batched decisions, deterministic replies, scoped evidence and durable failclosed diagnostics`; safety: `all team roles refuse personal auto-response and review continuations; production readiness fails closed` | Synthetic semantic choices, not model calibration |
| R6 / A3 thresholds | decisions: `strict affirmative thresholds; invalid confidence/settings fail closed`; assignments: `real classifier ordering and 90-percent inquiry dispatch nothing until its exact confirmation` | Exact .96/.95/.81/.80/none boundaries; settings CAS/access suite |
| R7 / A4 acknowledgment/direct | same I journey; I: `loose confirmation clarifies, accepted classifier outage is explicit, replay sends neither twice`; I: `inquiry buttons authenticate exact chat/thread/receipt and reject outsider or malformed callbacks` | Actual send IDs, thread and reply targets; exact callback confirm/dismiss |
| R8 / A4 destinations | same I journey; assignments: `durable acceptance, one acknowledgment, scoped final receipts and unknown delivery holds` | Original thread receipts and loose-confirmation clarification are asserted separately; uncertain output is not resent |
| R9 / A6 chain | same I journey; assignments: `exact inquiry reply and current membership; delegated receipts are internal and durable` | Real Bob → Product → Designer → QA → reviewer tools; private child results, Bob-only final; ten-turn/stale-tool denial |
| R10 / A5,A7 continuity/memory | same I journey; memory: `journaled team topics: CAS, evidence isolation, links, paging, safe revert and no personal replication`; context: `durable full history, edit versions, pending dedup, scoped reply routing and entity-safe aliases` | Second enrolled human follows recorded QA reply with home offline; simultaneous distinct forum topic; role conversation IDs asserted |
| A7 silent learning | same I journey; memory: `quiet discussion uses the real isolated selected Pi writer, no specialist or Telegram output` | Actual isolated writer, source journal, no public reply; existing suite checks redaction/replay |
| A8 replay/restart/effects | same I journey; assignments: `crash claims, album consolidation, clarification, send uncertainty and removal are durable`; runtime: `real team HTTP to queue to synthetic provider: subject continuity, isolation and receipts` | Real stop/start and duplicate updates; existing suites cover dispatched/unknown runtime receipts and uncertain sends |
| A9 outages | I runtime and routing tests above; I: `recovery wake errors have durable sanitized member-visible diagnostics`; memory: `selected decision/writer unavailable is visible and never falls back` | No paid/live provider or live outage test |
| A10 unchanged private behavior | `test/assistant-collaboration-ask.test.ts`, `test/control-center-telegram.test.ts`, `test/assistant-telegram.test.ts`, `test/guardian-pi.test.ts`, existing social/relay/access suites | Focused regressions are not the full repository/UI gates |
| Media/output integration | I: `proactive accepted media retains full extracted source rather than only caption`; I: `long delivery preserves the final character and every actual chat/thread receipt without resend`; context full-history test | Direct/proactive/confirmed inquiry text/path propagation; actual provider receives >20k input, long sends preserve the tail; original binaries retained. No claim of native multimodal model support or live voice accuracy |

Additional core-review regressions exercise received signed account removal including cached claim-only identities, dedicated selected-cluster project sharing despite unrelated workspace grants, ordinary conversation access, same-request evidence coalescing, and actual provider-input context isolation. Idle SSE and ordinary transcript WebSocket readers close after received revocation; the synchronous outbound check prevents events escaping before invalidation delivery. Phone activity pagination, resource revision updates, memory editing and stale-response clearing have browser coverage.

The integrated fixture uses normal signed cluster/account snapshot routes, real enrollment APIs, webhook ingestion, SQLite queue, signed local execution, Pi tools, transcript receipts and synthetic streaming HTTP providers. It does not seed completed agent receipts or enable a production test bypass. Its Telegram connection record is synthetic; real bot provisioning/QR is tested separately. The host's first human is host-homed, the second independently homed; this is not two separate laptop homes plus a fourth EC2 machine. Exact agent/provider counts and private/public destinations are asserted.

## Deployment runbook — authorization required, not performed

### 1. Establish identity and release gates

The plan names Contigos but supplies **no verified AWS account, region, EC2 instance ID, service name or production cluster UUID**. Do not guess them. With operator approval, record AWS caller identity and region, verify the EC2 instance by independently confirmed tags/owner and SSM/SSH host identity, and match its persistent Joint Bob node ID and signed cluster UUID to the intended members. Record installed snapshot revision. Stop if any identity disagrees. No new instance, account, firewall opening or bot registration is implied.

Require full test/UI gates and review approval for the exact release artifact. The final native run reported 3,670 passed and 16 skipped, with zero failed assertions, but its supervised command left child-process cleanup incomplete. Focused team UI checks passed; the full UI gate remains incomplete with failures and timeouts. Chosen-title and Activity Chat title failures were reproduced on upstream main; other UI failures are not all classified. Do not describe these results as a fully green release. Verify Ubuntu/version, the actual existing service/unit and service account, persistent data/project/transcript paths, encryption-key location and normal installer/update lifecycle from the host's existing installation. Do not introduce a second receiver/service.

### 2. Backup and capacity before upgrade

Pause team reception/work safely (stop the existing service for a consistent offline snapshot if necessary; account for Telegram's queued updates). Record webhook status, inbox/outbox/assignment states, uncertain effects and latest receipts. Do not discard queued updates to make a dashboard look healthy.

Make a verified consistent backup of SQLite **including its WAL state** (SQLite backup API, or stop the writer and preserve the database/WAL together), team memory, dedicated project and normal conversation transcripts, configuration and encrypted credential store plus its protected key. Restrict backup access; never place plaintext credentials in memory, exports or logs. Test integrity and an isolated restore before any schema upgrade. Preserve the prior release artifact and matching backup together.

Measure disk space/inodes and growth, available RAM/swap, CPU load, file-descriptor/process limits and normal relay latency. Run the representative synthetic coordination fixture on a staging-equivalent host; record wall time, peak RSS/CPU, concurrent subject behavior, queue delay, provider latency and relay p95 latency under load. Six configured roles is not a sizing benchmark. Agree measurable headroom/SLOs with the operator before selecting any resize. No capacity or instance type is certified here.

### 3. Install and configure locally

Use the installation's existing reviewed installer/update flow for the approved artifact; restart the existing service and confirm persistent paths and snapshot revision. Verify all six selected Pi models and central decision/knowledge-writer selections are ready locally. Require production Guardian readiness and an actual member's approval for unsafe actions. Do not migrate execution to a laptop if readiness fails.

Create the dedicated empty shared project/team, configure each role and upload only authorized role skills/files. Provider credentials and human provider sign-ins belong on the hosting node using normal secret controls. Share MCP definitions, browser profiles and plugins to the team only from the host execution account on the host, then select them per role. Never copy personal profiles or logins: create a team browser profile and sign it in through human takeover. MCP sign-ins stay the host account's own.

### 4. Telegram and member acceptance

Only with explicit bot-owner approval: connect the dedicated bot through normal setup; verify HTTPS webhook ingress/secret validation without opening unreviewed infrastructure. Ensure the bot is not already used by private Bob or another assistant. Disable privacy mode as instructed and refresh whole-group visibility; a connected token alone is not readiness.

Have each human open their own authenticated enrollment QR/link, redeem privately, inspect the displayed Telegram identity and confirm within ten minutes. Bind only the intended group with its one-time challenge and authenticated confirmation. Explain Telegram's group visibility boundary. Confirm outsiders cause no models, memory or work.

Run direct QA, both threshold boundaries, exact Confirm/Dismiss, Bob's four-role chain, quiet learning, second-member follow-up and unrelated topic checks. Record actual chat/thread/message IDs and assignment/transcript receipts without secrets. With both actual member laptops offline, repeat work and then restart the host service. Confirm retained memory and no replay of uncertain effects. Synthetic tests do not replace these receipts.

### 5. Rollback / incident response

Disable team reception and stop team work before rollback; if no reviewed team-specific pause is available, stop the existing service and coordinate the relay interruption. Inventory in-flight/uncertain sends and tool operations. Preserve the post-upgrade data for reconciliation. Restore the matching pre-upgrade release **and verified consistent backup**, not an older binary against an unverified newer schema. Retain post-backup receipts so restoring a backup cannot silently replay sends already delivered since it was taken. Do not resume until the operator reconciles these effects and confirms safe receipt/inbox state. Never manually clear uncertain records as a retry mechanism. Keep history; use a new human-authorized request only after effects are understood.

No deployment, live Telegram setup, credential sign-in, infrastructure change or production capacity verification was performed in Task 10.
