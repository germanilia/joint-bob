# Conversation retention

Once an hour each node looks for conversations to delete. The first look runs five
minutes after the node starts. Three machine settings decide what goes and what is kept
of it, all in **Settings > Account > Conversation history**, all for the node's admin
only:

- `conversationRetentionDays`, the number of days without activity after which a
  conversation is deleted. It defaults to 40.
- `conversationRetentionScope`, five boxes that say how far the hourly check reaches.
  All six are off until the admin ticks them.
- `conversationBackup`, where a conversation is backed up before the check deletes it,
  and for how many days the backup is kept. Off until the admin chooses a place. See
  "Backups before deleting".

All are Settings GET/PUT fields kept in `node_settings`. In a PUT, leaving
`conversationRetentionScope` out keeps what is saved, a box that is left out keeps its
saved value, and a box the setting does not have is rejected. `conversationBackup`
follows the same rule for its parts.

## What is deleted with every box off

- A conversation with no activity for the set number of days, when the project's list
  still shows it. The list shows the 50 most recent conversations of a project, and 50
  more that schedules made. Anything older than that is never looked at.
- A conversation that never got a message, one hour after it was opened.

Kept in any case: pinned conversations, conversations a schedule
made, conversations that another node owns, and anything that is open, running or has a
prompt waiting.

## What each box adds

| Box | Field | What it adds |
|---|---|---|
| Also delete older conversations that the list no longer shows | `full` | Every conversation on record in a project is checked, wherever its transcript lies. |
| …and old transcripts that have no conversation record | `includeUnrecorded` | Transcripts in a current project's folders that no record points to. Needs the first box. |
| …and conversations started by schedules and webhooks | `includeScheduled` | The conversations a scheduled task or a webhook made, one per run. Needs the first box. |
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

## Backups before deleting

With a place chosen, the hourly check writes a conversation to that place first and
deletes it only when the backup is stored. So a conversation lives in the app for the
retention days, then as a backup for the backup days, and then it is gone.

| Field of `conversationBackup` | Meaning |
|---|---|
| `destination` | `off` (the default), `folder` or `s3`. |
| `keepDays` | Days a backup is kept, 30 by default. `0` keeps backups until somebody removes them. |
| `folder` | The folder on this node. Empty means `conversation-backups` in Joint Bob's data folder. |
| `s3.bucket`, `s3.region`, `s3.prefix` | The bucket, its region, and a prefix put in front of every object. |
| `s3.credentials` | `keys`: the access key saved with the setting (`s3.accessKeyId`, and `s3.secretAccessKey`, which is stored encrypted and never returned; `hasSecretAccessKey` says whether one is saved). `profile`: the AWS profile named in `s3.profile` on this node (empty: the default one), read through the AWS command line tool, so single sign-on, roles and an instance's own role all work. |
| `s3.endpoint` | The address of an S3-compatible service. Empty for Amazon S3. |

**What a backup is.** One `.tar.gz` per conversation, in a folder per project:
`<project>_<project id>/<date>_<agent>_<session id>_<title>.tar.gz`. In a bucket the
node's name comes first, so several nodes can share one bucket. Inside:

- `conversation.json`: the project, the title, the dates, the node, the conversation's
  records, and the list of files.
- `files/<agent>/…`: every transcript, sub-agent transcript and tool result, at the path
  it had under that agent's folder (`agentFolders` in `conversation.json` names the
  folders). Copied back to those paths, the agent's own tool can open the conversation
  again (for Claude Code, `claude --resume <session id>` in the project's folder).
- `conflicts/<node>/…`: the versions kept for review when two nodes continued it.

A folder backup is readable by the node's account only. The archive is read back whole
before the conversation is deleted, and S3 checks an upload against its hash.

**What is backed up.** Conversations the check deletes for their age, whichever box
reached them, and files left behind by earlier deletes when that box is ticked. **Not
backed up:** a conversation a person deletes, a delete that arrives from the node that
owns the conversation (the owner made the backup), Joint Bob's own background runs, and
empty conversations.

**When a backup cannot be made.** The conversation stays. The check stops backing up
for that hour, because a place that refuses one backup would refuse the rest, and
nothing more is deleted for its age until a backup succeeds. The reason is shown under
the backup settings and written to the node's log.

**When a backup goes.** At the end of every hourly check, backups older than `keepDays`
are deleted from the folder or the bucket they were written to. This also runs with
backups switched off, so backups made earlier still go on time. An archive that was
moved out of its folder is left alone: moving one is how to keep it. A bucket that
refuses a delete keeps its backups on the list and shows the reason; the others go on.
Pinning a conversation keeps it in the app for good, so it never becomes a backup.

The settings page has **Check that backups can be written**, which writes a small file
to the place typed in the form and removes it again. The same check is
`POST /api/settings/conversation-backups/check` with the setting as its body; it answers
`{ ok: true, where }` or `{ ok: false, message }`. `GET /api/settings/conversation-backups`
says where backups go, how many exist and how large they are, when the oldest goes, and
the last problem. Both are for the admin only. The dry run names the place too.

Backups are outside the app: it does not list them or open them, and there is no
restore button. In Joint Bob the conversation stays deleted, so files copied back are
not listed there. The folder must not lie inside a project (project files are
synchronized to other nodes) or inside an agent's transcript folder; such a folder is
refused.

A profile that signs in through single sign-on stops giving credentials when that
sign-in expires, and backups then wait, with the reason shown, until someone signs in
again. For a node that runs unattended an access key or a role is steadier.

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
pins, browser profiles, secrets that belong to a project or workspace,
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
