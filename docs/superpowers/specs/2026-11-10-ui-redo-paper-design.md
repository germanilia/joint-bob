# UI redo: Paper

Status: approved for building as **Paper · Editorial** (2026-11-10, "lets implement the editoral"). Plan: `docs/superpowers/plans/2026-11-10-ui-redo-paper-editorial.md`. Phase 1 (the style layer) is built, not committed.
Mock: `mocks/ui-redo/index.html` (open it through Files → Open in browser). The mock is the
reference for look and layout; where this document and the mock disagree, this document wins.

## Why

The user reviewed every screen of the live app, desktop and phone, and asked for a complete
makeover. What bothers them, measured on 2026-11-10:

- The desktop shows more than 60 controls before the first project or conversation. The
  conversation toolbar is 17 unlabeled icons next to four native dropdowns.
- Settings is a dialog over the app with 28 sections, more than 30 inner tabs drawn in two
  ways, four kinds of heading and three ways of saving (as you change, a local Save button,
  or the shared Save settings button).
- On the phone, Browser profiles is 20,454 px tall, Resources shows one skill per page,
  Notifications cuts its buttons off, Costs runs off the edge, and many controls are under
  36 px.
- The same "needs you / running / to review" counts appear in four places.

Their words for the target: warm, welcoming, smooth, modern, slick, minimal.

## How the user got here

Three rounds of mocks. Rejected: a dark control-room board; a glassy messenger look ("a bit
too much iPhoney"); a hand-drawn style. From three versions of a warm, minimal style they
picked **Paper**: "paper is a good direction". Two requirements carried through every round
and are fixed:

1. **Colour theme selection** stays: System (follows the device), Light, Sepia, Dark,
   Midnight, Graphite.
2. **Search with fuzzy matching in every dropdown, and type-ahead in fields.**

The user's vocabulary: "theme" means colours only; "style" means the whole look. Paper is the
style. There is one style; themes recolour it.

## Goals

- Every screen, desktop and phone, in the Paper style.
- One workspace layout instead of three columns of panels (below).
- Settings as a page, with one structure for all 28 sections.
- Every choice list is one searchable dropdown with fuzzy matching.
- Long lists fit the window and page; they never grow the page.

## Non-goals

- No feature is removed. Every action in today's toolbar, menus and Settings still exists
  and can be found; it may move.
- No server, API or data-model changes, except where a screen needs data it cannot get today
  (none known).
- The 28 Settings section names and their five groups stay.
- No new themes and no second style.

## Anti-goals (a failure even if it works)

- A redesign that hides features so deep the user cannot find them, or that needs a manual.
- Glass, blur, heavy colour fills, hand-drawn or decorative effects.
- Scrolling lists where today's rule says page (see Constraints).
- Breaking a flow the user relies on without saying so: the control center's exit rule,
  transfers between machines, the queued-message editor, takeover.

## Constraints

- Plain HTML, CSS and ES modules in `public/`, no framework and no front-end build step.
  Follow the existing module and test conventions.
- Content Security Policy is `default-src 'self'`: fonts are shipped in `public/` and loaded
  from the app, never from an outside service. DM Sans and Young Serif are SIL Open Font
  Licence fonts; ship each licence file next to the font, as `public/app/sketch/` does for
  Caveat.
- `public/sw.js` caches assets by `CACHE_NAME`; every release that changes assets bumps it.
- Project rules that apply:
  - The control center is left only by the person (Esc twice, Exit, the shortcut); code never
    switches the view away from it (`.agents/knowledge/control-center-ui.md`).
  - Lists fit the available height and page with Previous/Next; management screens are
    Settings pages, not extra dialogs (the user's standing preference).
- The phone interface (`body.focus-ui`, `public/app/focus-ui.js`) switches on by width
  (≤ 700 px). The redesign keeps one breakpoint rule for "phone".
- The browser tests in `test/ui` (230 files, outside CI, see memory note on the browser
  suite) assert on today's markup. They are updated as screens change, not deleted.

## The style

Values are in `mocks/ui-redo/src/n.css` (`.dN` base, `.v2` Paper, the theme blocks at the end).

- **Surfaces:** sand background; cream cards with a soft shadow for the conversation, its
  details and Settings pages; a slightly darker field colour for inputs and grouped rows. No
  borders; separation comes from space, fills and one hairline between rows.
- **Accent:** one forest green for what you can act on (primary buttons, selection, switches,
  focus ring). Status colours: amber = needs you, green = running, indigo = to review,
  red = danger.
- **Type:** Young Serif (regular weight) for page titles, section titles and the phone
  greeting; DM Sans for everything else. Body text 14–15 px on desktop, 16–16.5 px on the
  phone.
- **Shape:** rounded 10/14/20 px (small/medium/large), cards 24 px, pills for chips.
- **Motion:** small and functional only: focus rings, switch thumbs, a pulsing dot on running
  work. Respect reduced motion.
- **Themes:** every colour is a token; each theme sets the tokens. Dark, Midnight and
  Graphite use a lighter green accent and a hairline instead of shadows on cards.

## Layout

### Desktop workspace

- **Left column:** brand and New; search (also "ask Bob"); five places — Inbox, Projects,
  Board, Automations, Costs; then the conversation list in three groups: Needs you, Running,
  To review, each with its count. At the bottom: Settings and the person (name, machine,
  theme), which opens the theme picker.
- **Middle:** the open conversation. Title, project, state, Stop, Mark done and a ⋯ menu on
  one line. Under it, four chips: agent, model, effort, machine — each a searchable dropdown.
  Then the messages and the composer.
- **Right:** the conversation's details: Activity / Files / Git / Tasks as a segmented
  control, the summary, the two "when it stops" switches, and links to Browser, Terminal,
  Share and Schedule.
- Everything in today's toolbar that is not shown above goes into the ⋯ menu (rename, notify,
  dashboard, install, copy home-screen link, create assistant, conversation actions).
- **Projects** shows two columns: the projects under the places (search, cluster filter, groups,
  rows, pager) and beside them the chosen project's conversations with today's filters (labels,
  clusters, done, scheduled) and its Notes. Each column folds on its own chevron; a window too
  narrow for both and a readable conversation puts the details away first, then folds the left
  column to its rail. *(changed 2026-11-12 on the user's word: "two columns, one for projects,
  one for conversations")*
- **Board** is today's per-project task board (`#boardPanel`), shown in the middle. *(my call)*
- Each group in the left column shows the rows that fit, with "Show all" opening that group as
  a paged list in the middle. The column never scrolls. *(my call)*
- **Details are summaries.** Files shows the changed files, Git shows the branch and changes;
  opening a file or a diff opens today's full screen, restyled. The activity panel's side
  chat, Story and Activity overview become a fifth segment, "More". *(my call)*

### Phone

- **Home:** a greeting ("Good evening, Ilia · 7 need you · 4 running · 4 to review"), search,
  the same three groups, a floating New button, and four tabs: Inbox, Projects, Costs,
  Settings.
- **Conversation:** back, title and state, the agent/model/machine chips, messages, composer.
- **Details:** a sheet from the bottom with Activity/Files/Git/Tasks, the four run settings,
  the two switches and Mark done.
- Touch targets at least 44 px.

### Settings

- A page, not a dialog: its own list on the left (desktop) or a list that drills in (phone);
  "Back to Joint Bob" returns to the workspace.
- Every section has the same parts: group as a crumb, title, one sentence, a label saying
  where it applies (this machine / your machines / the cluster), and "Changes save as you
  make them".
- **No shared Save settings button.** Each change saves on its own, as many sections already
  do.
- Three kinds of section cover all 28:
  1. **List with tabs** (Connections, Relay, Cluster, Resources, Webhooks…): tabs, filter
     chips, a list, a pager, one primary action.
  2. **Form** (Account, Notifications, Conversations, System AI…): titled groups of rows, each
     row a label, one line of help and one control.
  3. **Long list** (Browser, Secrets, Workspaces, File sync…): filter, a searchable dropdown
     for the machine or type, rows of fixed height, a pager sized to the window.
- The theme chooser is on Account: six tiles that preview each theme.
- Text size stays as today: one size for everything plus a size per area, now mapped to the
  left column, the conversation, the details column and headers. *(my call)*

### Dropdowns and fields

- One dropdown component replaces every native `<select>` (105 in `public/index.html`) and
  extends `public/app/searchable-select.js`. Opening it shows a search box over the list;
  typing filters with fuzzy matching (letters in order: "op55" finds Opus 5.5), marks the
  matched letters, keeps groups when nothing is typed, and supports arrow keys, Enter and
  Escape. On the phone it opens as a bottom sheet with 48 px rows and does not raise the
  keyboard until the search box is tapped.
- Matching uses `public/app/fuzzy.js` (today only Settings search does). Names match letter by
  letter; the secondary line must contain what was typed.
- Type-ahead:
  - the workspace search suggests conversations, projects, settings and actions (it replaces
    the word match in `public/app/spotlight.js`);
  - the composer suggests commands after `/` and files after `@`;
  - Settings search suggests sections and their tabs.

## Open question for the user

**Where does Bob live?** The control center (Bob's chat, Monitoring/pause, Bob's agent
settings, and the tabs Live agents, Project overview, Automations, Bob's memory, Clusters,
Assistants, Dashboards) has no place in the mock. Its live board is the same three groups as
the new left column.

Proposed, for the user to correct: **Bob** becomes the first place in the left column, above
Inbox. It opens the control center as a page: Bob's chat in the middle, his tabs in the
right column. Its live board merges into Inbox. The search box's "ask Bob" sends to this
chat. On the phone the tabs become Inbox, Bob, Projects, Settings; Costs moves under
Settings. The exit rule then means: code never moves the person off the Bob page.

## Scope

`public/assistant.html` (the separate assistant app) is restyled in a last phase with the same
tokens and themes, keeping its structure. *(my call)*

## Left to the builder

- How to stage the work and release it (phases, order, whether a phase ships alone).
- CSS file organisation, token names, component markup.
- Exact sizes and spacing within the values above.
- How existing tests are adapted, and which new ones to add.
- Screens not drawn in the mock (board, costs, Git review, files, new project, the remaining
  Settings sections, dialogs): apply the style and the three Settings kinds; keep their
  current structure unless it breaks a rule above.
