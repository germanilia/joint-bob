# conversation-retention

What automatic processes may and may not delete.

## r-Kp5Td

A pinned or starred conversation is never deleted by any automatic process: the retention sweep, a cleanup, a background sweep, or any new code that removes conversations on its own. An automatic deleter must skip every key in `pinnedConversationKeys()` (src/user-pins.ts) and `starredConversationKeys()` (src/preferences.ts), as `src/server/conversation-retention.ts` does at both its checks (planning and right before the delete). Only a person may delete a kept conversation, and the inbox asks twice before it does.

Evidence: the user, designing the inbox's pin, star and folders: "conversations which have pinned or starred will never be deleted by any automated system process" · Added 2026-11-14
