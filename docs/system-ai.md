# System AI settings

Open **Settings → System AI** as the local node administrator. This screen brings together the background agent, sync check, dashboard agent, summary writer and instructions. It also offers a knowledge-cleanup override and login-profile selections for internal operations. The retired Quality evaluator and automatic feedback-learning controls are no longer shown.

Settings are shared with trusted twins through signed replication. Ordinary cluster members do not receive them. Each machine resolves its own installed agents, saved credentials and sign-ins. An unavailable saved choice stays selected. Fix its availability on the execution machine or choose another explicitly. Existing saved task settings enter twin sync on upgrade; simultaneous initial copies converge by node ID, while subsequent edits take precedence.

## Decision credentials

Choose TypeSafe or Laya for knowledge cleanup and automatic summary decisions. Select a saved system secret account, not a project attachment. Only admin-owned, non-website, non-project-owned secrets from this machine or its trusted twins qualify. Selecting one here never exports it to a project's agents or changes any secret attachments.

With no explicit TypeSafe account selected, a single eligible account can be used automatically. Several accounts require a choice. A deleted or unavailable explicit selection fails without falling back. Local Laya may run without a key. Its endpoint remains in the existing Classifiers settings.

Null operation overrides retain existing summary-writer behavior, and an unselected login profile retains existing sign-in selection. Legacy evaluator settings remain stored for compatibility, but do not start collection.

## Model routing

Bob auto picks a model for each prompt: the cheapest one that does the job, on the conversation's own agent. It never moves a conversation to another agent. The classifier (TypeSafe or Laya) uses the decision credential above, never a project's attached secrets. Because System AI settings and admin-owned secret accounts follow trusted twins, setting the key once on one twin is enough.

- **Route prompts with the Joint Bob default on this machine** turns the default routing on or off here. Named routing configurations people chose themselves are not affected.
- **Let machines on this relay use this decision model** appears only on a machine that serves a relay. A machine using the relay that has no decision credential of its own then sends the prompt text and the routing choices to the relay, which classifies them with its own key and returns only the answer. The key never leaves the relay. A relay that is off, refuses or cannot be reached is not asked again for ten minutes; the prompt then runs on its current model.
- The section shows where decisions come from on this machine, and the default models for each kind of task, cheapest first. When the first model cannot run here (not installed, not signed in, rejected), the next one is tried. If none can, the model is left as it is and the reason is recorded.

The defaults live in `src/routing-defaults.json` and ship with each release.

## Saving and conversation feedback

**Save settings** on System AI writes only this screen's agent and credential configuration. It does not validate hidden runtime paths or overwrite conversation defaults. Summary policy controls still save immediately; summary instructions save when leaving the text box. An admitted relay's existing summary policy still takes precedence over the saved twin policy.

The Quality dashboard, collection switch and collection API have been removed. No saved machine flag restarts collection. Marking a conversation Done still saves its rating and comments, but no longer launches automatic analysis or proposes lessons. Conversation review and system improvements are handled by separately configured scheduled agents. See [Quality retirement](quality-analytics.md).

An older twin continues receiving ordinary replication events during a rolling upgrade. System AI changes wait on a separate delivery queue until it supports them. No credential values travel in these settings events or appear in the settings API.
