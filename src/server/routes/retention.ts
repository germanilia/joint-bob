import { previewConversationRetention, retentionSwitches, type RetentionSwitches } from "../conversation-retention.js";
import { CONVERSATION_RETENTION_SCOPE_KEYS } from "../../conversation-retention.js";
import { app } from "../state.js";

// What the retention sweep would delete on this machine now, without deleting anything: counts and
// bytes per kind and per project. Each box is taken from the query (`full=1`, `includeUnrecorded=1`,
// `includeScheduled=1`, `includeTickets=1`, `leftovers=1`, `backgroundRuns=1`; `0` for unticked), or
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
