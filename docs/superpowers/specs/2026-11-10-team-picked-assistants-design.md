# Teams built from picked assistants

Status: approved and built (2026-11-10). Members come from the team's own machine for now; the six Contigos roles stay as the first team's members. It replaces the fixed six-role model in
`docs/assistant-teams.md` and the "never adopt personal assistants" rule in
`2026-11-09-contigos-telegram-team-design.md`.

## Decisions from the user

1. **A picked assistant brings everything.** That covers its instructions, skills, MCP
   servers, tools (browser, terminal), browser logins, harness, model and effort. A team does
   not create isolated copies. It also has no team-level MCP, browser or plugin selections,
   because the assistant's own settings apply.
2. **A Telegram agent gets a team.** When I create or edit a Telegram agent (an assistant with
   a connected bot), I can assign a team to it. That agent becomes the team's coordinator in
   Telegram.
3. **Roles are free.** A team is a list of members. Each member is one of my available
   assistants plus a role name I choose. No fixed Bob/Product/Designer/QA/PR reviewer/Support
   set exists. Telegram commands come from the member list: `/<role>` and `@<role>`.

## Model

- `assistant_team_members(team_id, role, assistant_id, position)` replaces
  `assistant_team_agents`. `role` is a lowercase command name
  (`^[a-z][a-z0-9_]{0,31}$`), unique within the team. An assistant may be a member of more
  than one team.
- `TeamRole` becomes `string`. `TEAM_ROLES` and `initializeTeamAgents` are removed.
- The coordinator is the Telegram agent the team is assigned to. It is not a member row. The
  `bob` special cases in decisions, delegation and the ten-child-turn limit move to the
  coordinator.
- The selections in `assistant_team_mcp_selection`, `assistant_team_browser_selection` and
  `assistant_team_plugins` are dropped. They are superseded by decision 1.

## Execution

A member's turn runs as that assistant: its own `personalAssistantSettings`, tool policy,
MCP names, login profiles, harness and model. Pi is no longer the only harness. The turn runs
on the assistant's own node, and its conversations stay separate from the assistant's
personal topics.

## Telegram

- The Telegram agent setup (`/api/personal-assistants/:id/telegram`) gets a **Team** picker.
  Assigning a team routes the bot's group traffic through the existing team pipeline:
  enrollment, monitoring thresholds, acknowledgment and labelled replies.
- The bot's command menu (`setMyCommands`) is rebuilt from the member list whenever members
  change. Unknown `/x` commands get a short "no such role" reply listing the current roles.
- Direct `/role` calls bypass attention thresholds, exactly as today.

## Access consequence (needs explicit acceptance)

"Brings everything" means anyone enrolled in the team can, through Telegram, make a member
use its owner's MCP sign-ins, browser logins and terminal. Today's design forbids that. The
team list therefore shows each member's resources ("uses: GitHub MCP, browser profile X,
terminal"). Only the assistant's owner can add it to a team.

## Open points

- **Available assistants:** my own assistants on any of my machines, or only those on the
  Telegram agent's machine? Proposed: any machine of mine. A member on an offline machine
  replies "<role> is offline".
- **Existing six Contigos roles:** migrate them as six members of the first team (role names
  kept), so current commands keep working.
