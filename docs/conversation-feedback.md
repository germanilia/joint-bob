# Conversation feedback

Every conversation marked done is learned from, with no person approving the result. Marking a conversation Done offers three choices:

- **Good** or **Bad**: an optional explanation, intended to be one or two sentences (1,000 characters maximum). The rating is authoritative.
- **Nothing — not important**: the conversation is still reviewed. The decision model decides whether it went well or badly, and lessons follow as for Good/Bad.

Closing without the dialog (Bob's review check, Organize) counts as not important.

## How a lesson is learned

1. Without a Good/Bad rating, the project's decision model rates the transcript **good** or **bad**.
2. The summary writer describes the outcome when the person left the description blank, and proposes up to three rules. Each rule has a scope:
   - **project**: depends on this project's code, infrastructure, tools or conventions;
   - **general**: about how an agent should work in any project.
3. The decision model judges each rule separately. Only rules it decides to **learn** are kept.
4. Kept rules are installed at once:
   - project rules in the project's `.agents/knowledge/` ([project knowledge](project-knowledge.md));
   - general rules in `general-knowledge/` of the Joint Bob source checkout on this machine. They ship with the next release, and every agent then reads them. A machine without that checkout keeps a general rule in the project and says so in its evidence.

A rule whose text already exists in its destination is not written twice. Each rule's evidence names its conversation.

## Reviewing what was learned

The Activity panel's **Rules** section lists every learned rule, newest first, marked **Project** or **General**, with its evidence and date. **Remove** deletes a rule and remembers it in `removed-rules.json` next to the subject files, so neither the closeout nor the summaries learn it again. General rules can be removed only on a machine that holds the Joint Bob source; elsewhere they are shown without the button.

Running summaries also install project rules during a conversation (see [project knowledge](project-knowledge.md)), whatever its rating.

## Recovery and visibility

Marking a conversation Done answers at once. The review runs after the answer and can take up to a minute; the badge says *Done · learning…* until it finishes. The page that marked it says once how it went: *Feedback reviewed* or, as an error, *Conversation is done, but learning failed: …*.

Reviews run one at a time on a machine, so closing many conversations at once (Organize, Select) queues them.

Feedback, its source and processing state replicate with conversation metadata. Each review belongs to the machine that last wrote its record: the one that was asked, or the one whose attempt failed. Only that machine runs or retries it, so two machines never run the same review. Every hour, starting a minute after startup, it runs reviews that a restart interrupted, and retries failed ones (after an hour, doubling up to a week; a day at a time while the decision model is not configured). A missing decision model or failed agent call remains an explicit error rather than an invented rating. The Done badge shows learning failures; its tooltip contains the description and error.

A newer rating or a reopen invalidates an older review in flight. Reopening clears the closeout record; marking Done again starts a new review.

Worktree cleanup waits while the project has unfinished feedback, so a failed review does not lose the transcript it needs to retry; it runs once a review finishes and none is left unfinished.

The automatic closing of conversations inactive for more than four days (`runInactiveConversationCloseout`) is not scheduled: the hourly sweep only finishes reviews of conversations a person or Bob closed.

## Focused tests

```sh
npm run test:file -- test/conversation-closeout.test.ts test/conversation-closeout-runtime.test.ts test/general-knowledge.test.ts test/conversation-digest.test.ts
npm run test:file -- test/ui/ui-chat-done-button.test.ts test/ui/ui-conversation-done.test.ts test/ui/ui-chat-menu-parity.test.ts test/ui/ui-optimistic-actions.test.ts
npm run typecheck
```
