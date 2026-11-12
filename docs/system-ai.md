# System AI settings

Open **Settings → System AI** as the local node administrator. This screen brings together the background agent, sync check, dashboard agent, summary writer and instructions. It also offers learning/feedback and knowledge-cleanup overrides, a restricted Claude Quality model, and login-profile selections for these internal operations.

Settings are shared with trusted twins through signed replication. Ordinary cluster members do not receive them. Each machine resolves its own installed agents, saved credentials and sign-ins. An unavailable saved choice stays selected. Fix its availability on the execution machine or choose another explicitly. Existing saved task settings enter twin sync on upgrade; simultaneous initial copies converge by node ID, while subsequent edits take precedence.

## Decision credentials

Choose TypeSafe or Laya for feedback, knowledge cleanup and automatic summary decisions. Select a saved system secret account, not a project attachment. Only admin-owned, non-website, non-project-owned secrets from this machine or its trusted twins qualify. Selecting one here never exports it to a project's agents or changes any secret attachments.

With no explicit TypeSafe account selected, a single eligible account can be used automatically. Several accounts require a choice. A deleted or unavailable explicit selection fails without falling back. Local Laya may run without a key. Its endpoint remains in the existing Classifiers settings.

Quality always uses Claude to explain and TypeSafe/Jev to judge. It uses the system TypeSafe account even when other internal decisions use Laya. Its Claude execution remains tool-free, with no hooks, MCP or native conversation persistence. Blank model keeps the current Claude default. Null operation overrides retain existing summary-writer behavior, and an unselected login profile retains existing sign-in selection.

## Model routing

Bob auto picks a model for each prompt: the cheapest one that does the job, on the conversation's own agent. It never moves a conversation to another agent. The classifier (TypeSafe or Laya) uses the decision credential above, never a project's attached secrets. Because System AI settings and admin-owned secret accounts follow trusted twins, setting the key once on one twin is enough.

- **Route prompts with the Joint Bob default on this machine** turns the default routing on or off here. Named routing configurations people chose themselves are not affected.
- **Let machines on this relay use this decision model** appears only on a machine that serves a relay. A machine using the relay that has no decision credential of its own then sends the prompt text and the routing choices to the relay, which classifies them with its own key and returns only the answer. The key never leaves the relay. A relay that is off, refuses or cannot be reached is not asked again for ten minutes; the prompt then runs on its current model.
- The section shows where decisions come from on this machine, and the default models for each kind of task, cheapest first. When the first model cannot run here (not installed, not signed in, rejected), the next one is tried. If none can, the model is left as it is and the reason is recorded.

The defaults live in `src/routing-defaults.json` and ship with each release.

## Saving and collection

**Save settings** on System AI writes only this screen's agent and credential configuration. It does not validate hidden runtime paths or overwrite conversation defaults. Summary policy controls still save immediately; summary instructions save when leaving the text box. An admitted relay's existing summary policy still takes precedence over the saved twin policy.

**Settings → Quality** remains the collection dashboard. Its collection switch saves immediately and belongs only to that machine. Enabling collection, collected insights, results and failures never replicate to a twin. After fixing evaluator access, use **Retry / scan local history** there. See [Quality analytics](quality-analytics.md) for privacy and retention.

An older twin continues receiving ordinary replication events during a rolling upgrade. System AI changes wait on a separate delivery queue until it supports them. No credential values travel in these settings events or appear in the settings API.
