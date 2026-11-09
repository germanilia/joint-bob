# Machine-local reply quality analytics

Open **Settings → Quality** on the machine that should collect metrics. The switch is **off by default**. Enable it on the Homeserver to backfill conversations already available there and continue analyzing local and normally synced activity.

The switch saves immediately, with inline saving, success or error feedback. There is no separate **Save settings** action on Quality. Expand **Filters** to narrow the dashboard; changes apply automatically. Source model, harness and evaluator choices come from accessible results; issue names have suggestions. **Clear filters** resets the selection. On phones the fields use full-width rows. **Coverage and evaluator details** holds the additional collection metadata, while collection errors remain visible.

The setting and all analytics tables belong only to that machine. It does not change a relay, turn on collection elsewhere, request missing conversations, take ownership, alter Done status, install shared rules, or grant access to any new project. Turning it off cancels active analysis and preserves existing results. An already submitted model request may still incur usage.

## Models and privacy

Configure the evaluator in **Settings → System AI**. Collection uses its restricted Claude model and the selected system `TYPESAFE_AI_API_KEY` account for Jev, independently of project attachments. With no explicit account selected, exactly one eligible system TypeSafe account may be used; several accounts require a choice. A missing or deleted explicit selection fails without substituting another key. Selecting the system account does not expose it to project agents. System AI configuration follows trusted twins, but collection enablement and analytics stay local. Missing sign-in, credentials or model access are shown as collection failures; there is no silent model substitution. Claude explains issues and proposes derived lessons; Jev judges evidence and categories, including new issue types. Model requests use bounded pieces of locally available evidence. They are not local-only inference: the configured model services receive those pieces.

Only derived reasons, lessons, judgments/probabilities, source identifiers, dates and numerical metrics are stored in local SQLite `quality_*` tables in `node.db`. No conversation or tool-output archive is created. Claude analysis disables native session persistence, hooks, tools and MCP, and uses a disposable empty working directory. Known secrets are redacted and source-specific/verbatim explanation text is withheld. Provider errors are not copied into logs or the dashboard because they can contain input.

Collected history survives normal transcript expiry and remains access-controlled. If a source has already disappeared, collection reports unavailable evidence rather than inventing a result or downloading a copy. Backfill cannot recover previously deleted transcripts. Current source retention is not changed.

## Reading the dashboard

- **Quality trend:** source activity dates, evaluated reply counts, issue rates and unknown outcomes, split by evaluator model cohort. Use the date, project, source model/harness, evaluator version and evaluator model filters for comparisons.
- **Issue types:** first/last observed dates and recurrence counts; click a type to see reasons and lessons.
- **Accepted lessons:** before/after recurrence and sample sizes when an already accepted project rule can be associated with an issue and has a known adoption date. This is association, not proof that a lesson caused improvement. Absence of recent observations is not automatic resolution.
- **Reasons and lessons:** paginated observations, source conversation links labelled with project names, inferred confidence, explanations and derived lessons. Links open separately so the dashboard stays available; an expired transcript may no longer open. These are not full transcript copies and do not automatically become shared project rules. Existing project-knowledge acceptance continues unchanged.
- **Collection status:** pending, running, waiting, complete, unavailable or failed conversations, plus known eligible reply coverage. Conversation-level human ratings are shown separately from inferred reply judgments and are not assigned to every reply. Unknown outcomes and missing feedback are never counted as successes.

Collection status shows the last evaluation time across the selected projects and groups repeated failures by reason, with conversation counts. For example, an ambiguous TypeSafe account selection directs you to **System AI** instead of repeating conversation IDs. These counts cover all dates, independently of the reply filters.

Load failures stay inline with connection/version guidance and a **Refresh** action. Previously displayed results are explicitly marked stale; collection controls stay disabled until a successful read. Late responses cannot overwrite a newer filter selection.

Use **Refresh** to see current progress; **Retry / scan local history** rechecks authorized local history and retries failed jobs when aggregation is enabled. It is disabled when collection is off. New activity uses existing local change notifications, not a new sync polling loop. Unchanged source/evaluator revisions skip history rereads and unchanged replies skip inference. A restart resumes the persistent serial queue.

All Quality routes and the setting require a local node administrator. Queries additionally restrict derived records and aggregates to projects visible to the signed-in account. No relay feed, export, extra data sharing or cross-machine analytics replication is added.
