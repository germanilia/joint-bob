# Conversation retention

Once an hour each node looks for conversations to delete. The first look runs five
minutes after the node starts. Two machine settings decide what goes, both in
**Settings > Account > Conversation history**, both for the node's admin only:

- `conversationRetentionDays`, the number of days without activity after which a
  conversation is deleted. It defaults to 40.
- `conversationRetentionScope`, six boxes that say how far the hourly check reaches.
  All six are off until the admin ticks them.

Both are Settings GET/PUT fields kept in `node_settings`. In a PUT, leaving
`conversationRetentionScope` out keeps what is saved, a box that is left out keeps its
saved value, and a box the setting does not have is rejected.

## What is deleted with every box off

- A conversation with no activity for the set number of days, when the project's list
  still shows it. The list shows the 50 most recent conversations of a project, and 50
  more that schedules made. Anything older than that is never looked at.
- A conversation that never got a message, one hour after it was opened.

Kept in any case: pinned conversations, ticket conversations, conversations a schedule
made, conversations that another node owns, and anything that is open, running or has a
prompt waiting.

## What each box adds

| Box | Field | What it adds |
|---|---|---|
| Also delete older conversations that the list no longer shows | `full` | Every conversation on record in a project is checked, wherever its transcript lies. |
| …and old transcripts that have no conversation record | `includeUnrecorded` | Transcripts in a current project's folders that no record points to. Needs the first box. |
| …and conversations started by schedules and webhooks | `includeScheduled` | The conversations a scheduled task or a webhook made, one per run. Needs the first box. |
| …and conversations of finished tickets | `includeTickets` | Conversations of tickets that are done or gone. Needs the first box. |
| Remove files left behind by conversations that were already deleted | `leftovers` | See "Files left behind" below. |
| Remove Joint Bob's own background-run transcripts after 7 days | `backgroundRuns` | Transcripts of Joint Bob's own work: summaries, titles, checks, reviews. They are never listed. |

With the first box ticked the age of a conversation is the time its newest transcript
was last written on this node.

## What is never deleted

- A pinned conversation.
- A conversation that is open in a browser, has a turn running on any node, has a
  background task or a run still going, has an update recovery pending, or has a prompt
  queued since the cutoff.
- A conversation another node owns. Only the owner deletes; see "Other nodes".
- An assistant's conversation, its topics and its team conversations.
- The conversation an existing scheduled task or webhook writes into every time.
- The conversation of a ticket that is not finished.
- A transcript outside every project's folders.
- Kiro's own sessions. Joint Bob only ever touches its own folder under Kiro's.
- A background run that a side chat still resumes.

Every candidate is checked against this list again right before it is deleted.

## Looking before deleting

**Show what would be deleted** under the boxes asks the node what the boxes that are
ticked on the page would delete right now. It does not use the saved boxes, so it can
be pressed before saving. It shows conversations, files and size for expired and empty
conversations, background runs, left-behind files and held-back conversations, then the
largest projects, then how many old conversations are kept and why. The button deletes
nothing. Nothing is deleted until the settings are saved, and then only at the next
hourly check. One check deletes at most 500 conversations and 2,000 background runs;
the rest go in the checks that follow.

The same answer comes from `GET /api/settings/retention-preview`, admin only. Each box
is a query parameter (`full=1`, `leftovers=0` and so on); a box that is not given takes
its saved value. `detail=1` adds the ids of the conversations.

## The order of a delete

A person's delete, the hourly check and a delete that arrives from another node all do
the same three steps:

1. One database transaction. Every segment of the conversation gets a tombstone, its
   records go, the rows that describe it go, the delete is queued for the other nodes,
   and each segment is written into the queue of unfinished deletes
   (`conversation_deletes_pending`). From here on the list no longer shows the
   conversation, even if a file of it is still on disk.
2. Files. Every transcript of the conversation wherever it lies under the harness's
   folder, copies a file synchronizer kept, unfinished transfers and saved copies
   beside it, and Claude's session folder with sub-agent transcripts and tool results.
3. Background tasks. The log and the shell exit file of each finished task of the
   conversation, then the task's rows.

A segment leaves the queue when steps 2 and 3 both ran for it without error. Both remove
only what is there, so they can run again. Whatever is in the queue is tried again at
the next start and in every hourly check, with every box off. So a node that stops
between the steps finishes the delete when it starts, and a file that could not be
removed is tried again within the hour. If a step fails, the delete itself still stands:
the conversation is gone from the list and the other nodes are told.

Rows that are kept: the tombstone, the usage ledger, quality records, the audit log,
pins, browser profiles, secrets that belong to a project or workspace, tickets,
schedules and their run history, and quick notes.

## Other nodes

Only the node that owns a conversation deletes it. The tombstone travels to the other
nodes. A node that receives it clears its own rows and puts the delete into its own
queue in the same transaction, then removes its own copies in steps 2 and 3. It does
this at once and whatever the tombstone's date: the date says when the conversation was
deleted, not when this node heard of it. An event about the conversation that was sent
before the delete and arrives after it is dropped, so it cannot bring rows back.

## Files left behind

Before the complete delete existed, a delete removed the transcript the project listed
and the record, and left the rest: a copy in another folder, sub-agent transcripts, the
copy on a node whose project did not list that folder. The first time a node runs this
release it writes down the deleted conversations it already knows
(`conversation_deletes_earlier`). None of them is in the queue, so nothing of them is
touched while the `leftovers` box is unticked: their files stay on disk, hidden from the
list, and their rows stay.

With the box ticked the node puts them into the queue, at start and in the hourly check,
and the queue removes their rows, files and task logs like any other delete. The box
also takes a file of a deleted conversation that turns up later.

## Held-back conversations

One kind of left-behind file is never removed automatically, with or without the box:
the transcript of a conversation that this node itself deleted before the complete
delete existed, and that is still on this node. A delete used to remove the listed
transcript first, so a transcript that outlived its own node's delete was never where
the project listed it. Earlier releases could take such a conversation for empty and
delete its record an hour after it was opened, although it held real work. Its files,
rows and task logs are left alone, it is never put into the queue, and the dry run
counts it under "Held back, not deleted".

The other node treats its own copy as a left-behind file and removes it when its
`leftovers` box is ticked. That removal sends nothing, so the node that made the delete
keeps the original. If the other node later deletes the same conversation itself, its
tombstone is newer and replaces this node's, as between any two nodes, and the copy
here still stays held back.
