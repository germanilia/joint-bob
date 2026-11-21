// One link that sets up a machine (Settings › Cluster › Add a machine). See ../machine-link.ts.
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { actingAccount } from "../../account-context.js";
import { accountIdForUser, localAccountsForReplication, type AuthSession } from "../../auth.js";
import { adminAccountId } from "../../ownership.js";
import { getClusterNode } from "../../cluster.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { ClusterV2HttpError } from "../../cluster-v2-errors.js";
import { RelayRuntimeError } from "../../relay/runtime.js";
import { mapV2Error } from "../cluster-v2.js";
import { sendError } from "../http-auth.js";
import { createMachineLink, parseMachineLink, summarizeMachineLink, useMachineLink } from "../machine-link.js";
import { app } from "../state.js";
import { invitedTwin, sharingTwin } from "../twin-sharing.js";
import { createTwinHttpInvitation, ensureTwinHttpSchema } from "../twins.js";
import { issueClusterInvitation, joinClusterByLink } from "./cluster-v2.js";

const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);

function handler(action: (request: Request, response: Response) => Promise<void>): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    void action(request, response).catch((error) => {
      if (error instanceof RelayRuntimeError) { sendError(response, error.statusCode, error.message); return; }
      mapV2Error(error, response, next);
    });
  };
}

/** The node's own signed-in person; ADMIN_ROUTES already limits these routes to its admin. */
function localPerson(response: Response): string {
  const account = actingAccount();
  if (!response.locals.authSession || !account || account.isRemoteLogin) throw new ClusterV2HttpError(404, "Not found");
  return account.accountId;
}

// Sharing everything this person owns with another machine is confirmed the same way a twin link is.
const ownConfirmed = (own: boolean, confirmOwnedData: unknown): void => {
  if (own && confirmOwnedData !== true) throw new ClusterV2HttpError(400, "Confirm that everything you own will be shared with the machine");
};

app.post("/api/machine-links", handler(async (request, response) => {
  localPerson(response);
  const body = z.object({ own: z.boolean(), clusterIds: z.array(uuid).max(16).default([]), confirmOwnedData: z.boolean().optional() }).strict().parse(request.body);
  ownConfirmed(body.own, body.confirmOwnedData);
  response.status(201).json(await createMachineLink({ own: body.own, clusterIds: body.clusterIds, issueClusterInvitation }));
}));

/** What a pasted link would do, before anything is done. */
app.post("/api/machine-links/inspect", handler(async (request, response) => {
  localPerson(response);
  const bundle = parseMachineLink(z.object({ link: z.string().max(65536) }).strict().parse(request.body).link);
  response.json({ summary: summarizeMachineLink(bundle), expired: Date.now() > bundle.expiresAt, issuedHere: bundle.issuer.nodeId === (await getClusterNode()).id });
}));

app.post("/api/machine-links/use", handler(async (request, response) => {
  const accountId = localPerson(response);
  const body = z.object({ link: z.string().max(65536), confirmOwnedData: z.boolean().optional() }).strict().parse(request.body);
  ownConfirmed(parseMachineLink(body.link).twins.length > 0, body.confirmOwnedData);
  // Becoming a twin may have given this person the twin's account; the clusters are joined as who they are by then.
  const userId = (response.locals.authSession as AuthSession).userId;
  response.json(await useMachineLink(body.link, (link, requestId) => joinClusterByLink(link, requestId, accountIdForUser(userId) ?? accountId)));
}));

/**
 * A twin asks this machine for a twin invitation, to hand to a machine it is adding. Twins are
 * the same person's machines and already share everything, so the request of one stands for
 * the consent this machine's own "Generate twin link" button asks for.
 */
app.post("/api/cluster/v2/twins/vouch", handler(async (request, response) => {
  if (response.locals.machineProtocol !== 2 || typeof response.locals.machineNodeId !== "string") throw new ClusterV2HttpError(401, "Unauthorized");
  const sender = response.locals.machineNodeId as string;
  const { relationshipId } = z.object({ relationshipId: uuid }).strict().parse(request.body);
  const local = await getClusterNode(), db = await clusterV2Database();
  ensureTwinHttpSchema(db);
  if (sharingTwin(db, local.id, relationshipId) !== sender) throw new ClusterV2HttpError(403, "Forbidden");
  response.status(201).json({ link: (await createTwinHttpInvitation()).link });
}));

/**
 * A machine that accepted this machine's twin invitation asks who the administrator is, to
 * become the same account (see adoptTwinAdministrators). It is the sign-in record a twin is
 * sent anyway, here marked as the administrator's, and only the invited side may ask.
 */
app.post("/api/cluster/v2/twins/administrator", handler(async (request, response) => {
  if (response.locals.machineProtocol !== 2 || typeof response.locals.machineNodeId !== "string") throw new ClusterV2HttpError(401, "Unauthorized");
  const sender = response.locals.machineNodeId as string;
  const { relationshipId } = z.object({ relationshipId: uuid }).strict().parse(request.body);
  const local = await getClusterNode(), db = await clusterV2Database();
  ensureTwinHttpSchema(db);
  if (sharingTwin(db, local.id, relationshipId) !== sender || !invitedTwin(db, relationshipId, sender)) throw new ClusterV2HttpError(403, "Forbidden");
  const admin = adminAccountId(db), account = localAccountsForReplication().find((item) => item.accountId === admin);
  if (!account) throw new ClusterV2HttpError(404, "Not found");
  response.json({ username: account.username, email: account.email, passwordHash: account.passwordHash.toString("hex"), passwordSalt: account.passwordSalt.toString("hex") });
}));
