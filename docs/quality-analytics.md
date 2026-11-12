# Quality collection retired

The built-in Quality dashboard, machine collection controls, evaluator controls and collection API have been removed. Old enabled flags are ignored: startup no longer starts the collector or automatic conversation-closeout reviewer. Existing local quality records are not deleted.

**Done → feedback** remains available. Ratings and comments are saved as entered and remain associated with the conversation through the existing feedback storage and replication. Saving feedback no longer launches an evaluator or a learning agent. Reopening retains the existing behavior of clearing Done and its closeout feedback.

Conversation review and system improvement belong in ordinary scheduled agent tasks, configured by the user. Those tasks can inspect conversations and feedback, decide whether a change is warranted, run the project's verification and follow the normal release workflow, just as the scheduled model-routing review does. Removing Quality does not create a scheduled task, grant credentials or authorize a release automatically.

Project knowledge, conversation summaries, normal usage accounting and model-routing configuration are separate features and remain available.
