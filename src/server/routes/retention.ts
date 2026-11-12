import path from "node:path";
import { checkBackupDestination, conversationBackupStatus } from "../conversation-backup.js";
import { previewConversationRetention, retentionSwitches, type RetentionSwitches } from "../conversation-retention.js";
import { CONVERSATION_RETENTION_SCOPE_KEYS, mergedConversationBackup } from "../../conversation-retention.js";
import { getSettings } from "../../settings.js";
import { conversationBackupSchema } from "../schemas.js";
import { app } from "../state.js";

// What the retention sweep would delete on this machine now, without deleting anything: counts and
// bytes per kind and per project. Each box is taken from the query (`full=1`, `includeUnrecorded=1`,
// `includeScheduled=1`, `leftovers=1`, `backgroundRuns=1`; `0` for unticked), or
// from the saved setting when it is not given, so the settings page can show what its ticked boxes
// would do before they are saved. `detail=1` adds the conversations themselves. Admin only
// (src/server/admin.ts): it names every project's conversations.
app.get("/api/settings/retention-preview", async (request, response, next) => {
  try {
    const saved = retentionSwitches();
    const switches = Object.fromEntries(CONVERSATION_RETENTION_SCOPE_KEYS.map((key) => [key, typeof request.query[key] === "string" ? request.query[key] === "1" : saved[key]])) as unknown as RetentionSwitches;
    const preview = await previewConversationRetention(switches);
    const { conversations, ...summary } = preview;
    response.json(request.query.detail === "1" ? preview : summary);
  } catch (error) {
    next(error);
  }
});

// Where this machine backs conversations up before the sweep deletes them, how many backups exist
// now, and the last problem. Admin only.
app.get("/api/settings/conversation-backups", async (_request, response, next) => {
  try { response.json(await conversationBackupStatus()); } catch (error) { next(error); }
});

// Writes a small file to the backup destination and removes it again. The body may carry a backup
// setting that is not saved yet (the same shape a save takes), so the page can check what is typed
// before saving it; a secret key in it is used for this check only. Answers { ok, where } or
// { ok: false, message }: a destination that refuses is an answer, not a failed request.
app.post("/api/settings/conversation-backups/check", async (request, response, next) => {
  try {
    const input = conversationBackupSchema.parse(request.body ?? {});
    const { hasSecretAccessKey, defaultFolder: _defaultFolder, ...saved } = getSettings().conversationBackup;
    const typedSecret = input.s3?.secretAccessKey || undefined;
    let where: string;
    try {
      const candidate = mergedConversationBackup(saved, input, hasSecretAccessKey || typedSecret !== undefined, path.isAbsolute);
      where = await checkBackupDestination(candidate, typedSecret);
    } catch (error) { response.json({ ok: false, message: error instanceof Error ? error.message : String(error) }); return; }
    response.json({ ok: true, where });
  } catch (error) { next(error); }
});
