import { randomUUID } from "node:crypto";
import { z } from "zod";
import { actingAccountFromSession, runAsAccount } from "../account-context.js";
import type { AuthSession } from "../auth.js";
import { bobSays, registerBobAction } from "../control-center/bob-actions.js";
import { formatTeamStatus } from "../assistant-teams/control-text.js";
import { hubAssign, hubCancel, hubRequests, hubRetry, hubTeamRef, hubTeams, type HubTeam } from "./team-hub.js";
import { closeTeamFollow, followTeamRequest } from "./team-follows.js";

// Bob steers the teams of the person's clusters, on whichever machine hosts them: what a team is doing, work for one of its
// members, and stopping or repeating a request. Asking is answered at once; sending work or changing a request waits for the
// person's button, like every other change Bob makes (control-center-organize.ts). A team member is a full agent with its own
// sign-ins, so work sent to it runs on the team's host as the person, and Bob brings its answer back to the chat.

const id = z.string().min(1).max(240);
export const teamIntentShapes = [
  z.object({ intent: z.literal("team-status"), team: id, role: z.string().max(40).nullable() }),
  z.object({ intent: z.literal("team-assign"), team: id, role: z.string().max(40).nullable(), message: z.string().trim().min(1).max(20_000) }),
  z.object({ intent: z.literal("team-cancel"), team: id, request: z.string().max(64).nullable() }),
  z.object({ intent: z.literal("team-retry"), team: id, request: z.string().max(64).nullable() }),
] as const;
export type TeamIntent = z.infer<(typeof teamIntentShapes)[number]>;
export const TEAM_INTENTS = new Set<string>(teamIntentShapes.map((shape) => shape.shape.intent.value));

export const TEAM_INSTRUCTIONS = [
  '{"intent":"team-status","team":"<team id>","role":null} when the user asks what one of the listed teams is doing, where its work stands, what is stuck or what it still has to do; "role":"<role>" when they ask about one member of it.',
  '{"intent":"team-assign","team":"<team id>","role":"<role>","message":"what the user wants that member to do, in their words"} when the user asks a member of a listed team (by its role) or the team itself to do some work: to check, build, write, review or investigate something. "role":null sends it to the team\'s coordinator, who hands it on.',
  '{"intent":"team-cancel","team":"<team id>","request":null} to stop the latest unfinished request of a listed team; "request":"<id>" for one the user named by its id.',
  '{"intent":"team-retry","team":"<team id>","request":null} to run a stopped request of a listed team again; "request":"<id>" for one the user named.',
];

/** The teams Bob may name, as the agent that reads the message sees them. */
export interface TeamWorld { id: string; name: string; host: string; roles: string[]; coordinator: string | null }
export const teamWorldOf = (teams: HubTeam[]): TeamWorld[] => teams.map((team) => ({ id: team.id, name: team.clusterName, host: team.hostName, roles: team.members.map((member) => member.role), coordinator: team.coordinatorRole }));

export const teamOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("team-assign"), teamId: id, teamName: z.string(), role: z.string().max(40).nullable(), roleLabel: z.string(), message: z.string().min(1).max(20_000) }),
  z.object({ op: z.literal("team-cancel"), teamId: id, teamName: z.string(), request: z.string().max(64).nullable() }),
  z.object({ op: z.literal("team-retry"), teamId: id, teamName: z.string(), request: z.string().max(64).nullable() }),
]);
export type TeamOperation = z.infer<typeof teamOperationSchema>;

/** A question with a button, or an answer. */
export type TeamOffer = { text: string } & ({ ask: true; button: string; operation: TeamOperation } | { ask: false });
const answer = (text: string): TeamOffer => ({ ask: false, text });
const problem = (error: unknown): string => error instanceof Error ? error.message.slice(0, 200) : String(error);
const place = (team: HubTeam): string => `the ${team.clusterName} team${team.local ? "" : ` (hosted on ${team.hostName})`}`;

async function find(session: AuthSession, teamId: string): Promise<HubTeam | string> {
  const team = (await hubTeams(session)).find((candidate) => candidate.id === teamId);
  return team ?? "I could not find that team among the clusters you joined.";
}

/** What the intent would do, said plainly, or the answer when it only reads. */
export async function offerTeam(session: AuthSession, intent: TeamIntent): Promise<TeamOffer> {
  const team = await find(session, intent.team);
  if (typeof team === "string") return answer(team);
  const roleOf = (role: string | null) => role ? team.members.find((member) => member.role === role.toLowerCase()) : undefined;
  if (intent.intent === "team-status") {
    if (intent.role && !roleOf(intent.role)) return answer(`${place(team)} has no member called ${intent.role}. Its members are ${team.members.map((member) => member.role).join(", ")}.`);
    try {
      const views = await hubRequests(session, team.id);
      const shown = intent.role ? views.filter((view) => view.assignments.some((part) => part.role === intent.role!.toLowerCase())) : views;
      const members = team.members.map((member) => `${member.role}${member.coordinator ? " (coordinator)" : ""}${member.ready ? "" : " — not ready on its machine"}`).join(", ");
      return answer(`${place(team)}: ${members}.\n\n${formatTeamStatus(shown, intent.role)}`);
    } catch (error) { return answer(`I could not read ${place(team)}: ${problem(error)}.`); }
  }
  if (intent.intent === "team-assign") {
    const member = intent.role ? roleOf(intent.role) : team.members.find((candidate) => candidate.coordinator) ?? team.members[0];
    if (!member) return answer(intent.role ? `${place(team)} has no member called ${intent.role}. Its members are ${team.members.map((entry) => entry.role).join(", ") || "none yet"}.` : `${place(team)} has no members yet.`);
    if (!member.ready) return answer(`${member.role} is not ready on ${team.hostName}, so work sent now would not start. Check it in the team's settings on that machine.`);
    const text = `Send this to ${member.role}${member.coordinator && !intent.role ? " (the coordinator)" : ""} on ${place(team)}? It runs on ${team.hostName} as you, with the sign-ins and tools that assistant holds. I'll bring its answer here when it is done.\n${intent.message.slice(0, 600)}`;
    return { ask: true, text, button: "Send it", operation: { op: "team-assign", teamId: team.id, teamName: team.clusterName, role: member.role, roleLabel: member.role, message: intent.message } };
  }
  const retrying = intent.intent === "team-retry";
  const ref = intent.request;
  return { ask: true, text: `${retrying ? "Run again" : "Stop"} ${ref ? `request ${ref}` : retrying ? "the latest stopped request" : "the latest unfinished request"} of ${place(team)}?${retrying ? " It starts again as a new request; the old one is retired." : " A running turn is told to stop and waiting work is dropped."}`,
    button: retrying ? "Run it again" : "Stop it", operation: { op: retrying ? "team-retry" : "team-cancel", teamId: team.id, teamName: team.clusterName, request: ref } };
}

export async function runTeamOperation(session: AuthSession, operation: TeamOperation): Promise<string> {
  if (operation.op === "team-assign") {
    const view = await hubAssign(session, operation.teamId, operation.role, operation.message, randomUUID());
    // Kept on disk: the answer is brought back even if this machine or the team's host restarts meanwhile.
    await followTeamRequest(session.accountId, await hubTeamRef(session, operation.teamId), `${operation.roleLabel} on the ${operation.teamName} team`, view.id);
    return `Sent to ${operation.roleLabel} on the ${operation.teamName} team (request ${view.shortId}). I'll bring its answer here when it is done, even if a machine restarts meanwhile.`;
  }
  if (operation.op === "team-cancel") {
    const { request, stopFailures } = await hubCancel(session, operation.teamId, operation.request);
    await closeTeamFollow(session.accountId, request.id);
    return `Stopped request ${request.shortId} of the ${operation.teamName} team.${stopFailures ? " A running turn could not be stopped; it may still finish, but its result is dropped." : ""}`;
  }
  const { previous, request } = await hubRetry(session, operation.teamId, operation.request);
  await closeTeamFollow(session.accountId, previous.id);
  await followTeamRequest(session.accountId, await hubTeamRef(session, operation.teamId), `Request ${request.shortId} of the ${operation.teamName} team`, request.id);
  return `Running ${previous.shortId} again as ${request.shortId}. I'll bring its answer here when it is done, even if a machine restarts meanwhile.`;
}

registerBobAction("team.run", async ({ db, session, action }) => {
  const { operation } = z.object({ operation: teamOperationSchema }).parse(action.data);
  // The person pressed the button, so the work is theirs: it runs as them, with their rights, on the team's host.
  const text = await runAsAccount(actingAccountFromSession(session), () => runTeamOperation(session, operation));
  return [bobSays(db, session, text, { importance: "done", via: `Team · ${operation.op.replace("team-", "")}` })];
});
