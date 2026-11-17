# Automations editor: module contract

The editor is a full page inside the control-center Automations tab (`public/app/control-automations.js`). The shell owns the page, the tabs, the save bar and every call that saves the automation. Each tab is its own module that builds its own DOM and answers the same small interface, so the pieces can be written independently. Design reference: `mockups/automations-unified.html` (open it in a browser, or read its markup and script). API reference: the "new server API" section of the task brief, restated below.

## API recap (all JSON, via `api()` from `./api.js`)

`?nodeId=<uuid>` picks the machine that stores the automation; leave it out for this machine.

- `GET /api/automations/owners?projectId=` → `{ owners: [{ id, name, local, twin }] }`
- `GET /api/automations?nodeId=` → `{ automations: Item[], bases, startupReady, telegramSenderFields }`
- `GET /api/automations/options?nodeId=` → `{ secretAccounts: [{ id, label, provider, projectId }], harnesses: [{ id, label, thinkingLevels }], models: [{ harnessId, provider, id, label, thinkingLevels? }] }`
- `GET /api/automations/profiles?nodeId=` → `{ profiles, pools }` (for `createAutomationPoolPicker` in `provider-profile-picker.js`)
- `GET /api/automations/projects?nodeId=` → `{ projects: [{ id, name }] }`
- `GET /api/automations/projects/:projectId/sessions?nodeId=` → `{ sessions: [{ id, title, firstMessage, harnessId }] }`
- `POST /api/automations?nodeId=` body `Input` → 201 `{ automation: Item, secret: string | null, bases }`
- `PUT /api/automations/:id?nodeId=` body `Input` → `{ automation, secret, bases }` (`secret` only when the trigger changed from schedule to webhook)
- `DELETE /api/automations/:id?nodeId=` → 204 · `POST /api/automations/:id/run?nodeId=` → `{ automation }`
- `POST /api/automations/:id/regenerate?nodeId=` → `{ automation, secret, bases }` (webhook only)
- `POST /api/automations/:id/transfer?nodeId=` body `{ nodeId }` → `{ automation, secret | null, bases }`
- `GET /api/automations/:id/history?nodeId=` → `{ calls: [{ at, status, detail, sender }], runs: [{ id, dueAt, status, error, sessionId, finishedAt }] }`
- Context, for either trigger: `/api/automations/:id/resources[...]`, `/skills[...]`, `/memory` exactly as the old `/api/webhooks/:id/...` routes (see `webhook-files.js`, `webhook-skills.js`, `webhook-memory.js`).
- `GET /api/auto-respond/defaults` → `{ instructions, stopInstructions, maxResponses }`

`Item` and `Input` (strict; send only these): see `src/webhooks.ts` `webhookInputSchema` and `interface Webhook`.
`Input` = `{ trigger, name, target, context, enabled, tags, model, reasoning, titleTemplate, secretAccountIds, providerProfileId?, providerPoolId?, bypassGuardian, markForReview, hideFromHistory, preserveFiles, runInWorktree, autoRespond, pauseOnFailure, schedule, attachments, senders }`.
Rules: a schedule needs non-empty `context` and a `schedule` and has no `attachments`/`senders`; a webhook has `schedule: null`; an assistant `target` has no `model`/`reasoning`.

## The context the shell gives every tab

```js
const ctx = {
  api,                          // ./api.js
  say(message, kind = "info"),  // the editor's status line ("info" | "ok" | "error"); "" clears it
  state: {                      // live; tabs read it, only the shell writes it
    item,                       // the saved Item, or null while creating
    nodeId,                     // machine that stores it ("" = this machine)
    trigger,                    // "schedule" | "webhook"
    projectId,                  // the project chosen on Setup
    options: { harnesses, models, secretAccounts, projects, owners },   // loaded for nodeId
    telegramSenderFields,       // string[]
  },
  endpoint(suffix = ""),        // `/api/automations${suffix}` + `?nodeId=` (for list/create/options)
  url(suffix = ""),             // `/api/automations/${item.id}${suffix}` + `?nodeId=` (only once the item exists)
  run(work),                    // one guarded async action at a time; an error goes to say(error, "error")
  markDirty(),                  // call after any edit the person makes
  reload(),                     // reread the item from the server and refill every tab
};
```

## The tab interface

Each module exports `createXxxTab(ctx)` and returns:

```js
{
  element,            // the tab body; the shell shows and hides it
  fill(item, defaults),   // put a saved Item's values in the fields; item is null for a new automation (use defaults / sensible blanks)
  read(shared),       // the Input fields this tab owns (see below); throws Error("a readable sentence") for an invalid field. `shared` = { projectId, trigger, nodeId }
  onShow?(),          // optional: the tab was opened (load lazy data here)
  onTrigger?(kind),   // optional: the trigger changed on Setup
  onNode?(),          // optional: ctx.state.nodeId or ctx.state.options changed
}
```

Field ownership (so `read()` results merge without overlap):

| Module | File | Owns |
|---|---|---|
| Setup + shell | `automation-editor.js` | `trigger`, `name`, `context`, `tags`, `titleTemplate`, `enabled`, the project choice, the History tab, the header, the save bar, the address page |
| Trigger | `automation-trigger.js` | `schedule` (schedule trigger) · `attachments`, `senders` (webhook trigger); the address card for a saved webhook with "New address" |
| Run | `automation-run.js` | `target`, `model`, `reasoning`, `providerProfileId`, `providerPoolId`, `runInWorktree`, `preserveFiles`, `bypassGuardian`, `markForReview`, `hideFromHistory`, `pauseOnFailure`, `autoRespond`; the machine select |
| Context | `automation-context.js` | `secretAccountIds`; Files & tools, Skills and Memory, which apply at once through their own endpoints |

Shell responsibilities: build `ctx`; load owners/options/projects/profiles for the machine; call each tab's `fill`; on Save build `Input = { trigger, enabled, ...setup.read(), ...trigger.read(shared), ...run.read(shared), ...context.read(shared) }`, POST or PUT it, then show the address page when `secret` is returned; header actions (Run now, Turn on/off, ⋯ menu: New address (webhook only), Transfer to another machine, Delete); the trigger-switch warnings; the History tab; `reload()`.

## Files and CSS

Each module owns one CSS file next to `public/styles.css` conventions (see how `control-automations.css` is linked): `automation-editor.css`, `automation-trigger.css`, `automation-run.css`, `automation-context.css`. The shell agent links all four in `public/index.html` and lists every new JS/CSS file in the offline service-worker shell so `test/source-invariants.test.ts` passes; the other agents only create their own files.

## Quality bar

Smallest clear code; reuse `makeNode`, `makeButton`, `makeTwoStepButton`, `createFittedList`, `showStatus`, `copyText` (`relay-ui.js`), `createAutomationPoolPicker` (`provider-profile-picker.js`), `createAutomationTagPicker` (`automation-tag-picker.js`), `fillModelOptions` / `selectedModel` (`git-reviewer-options.js`). No defensive code for impossible states; errors from the API reach the status line. Every interactive element gets a `data-testid` starting with `automation-`. Lists page (`createFittedList`), they do not scroll.
