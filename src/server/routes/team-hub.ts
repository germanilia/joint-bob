import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { AuthSession } from '../../auth.js';
import { TeamError } from '../../assistant-teams/store.js';
import { hubAssign, hubCancel, hubDecideProposal, hubDelete, hubOverview, hubProposals, hubRequests, hubRetry } from '../team-hub.js';
import { app } from '../state.js';

// The app's view of the teams of the person's clusters, wherever they run: see ../team-hub.ts.

const teamId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
const ref = z.object({ ref: z.string().max(64).nullable() }).strict();

function route(handler: (request: Request, session: AuthSession) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const session = response.locals.authSession as AuthSession | undefined;
    if (!session) { response.status(401).json({ error: 'Authentication required' }); return; }
    handler(request, session).then(result => response.json(result)).catch(error => {
      if (error instanceof TeamError) { response.status(error.status).json({ error: error.message }); return; }
      if (error instanceof z.ZodError) { response.status(400).json({ error: 'Invalid team request' }); return; }
      next(error);
    });
  };
}

app.get('/api/team-hub', route(async (request, session) => {
  const { teams, unreachable } = await hubOverview(session, request.query.fresh === '1');
  return { teams, unreachable };
}));
app.get('/api/team-hub/:teamId/requests', route(async (request, session) => ({ requests: await hubRequests(session, teamId.parse(request.params.teamId)) })));
app.post('/api/team-hub/:teamId/assign', route(async (request, session) => {
  const body = z.object({ role: z.string().nullable(), message: z.string().trim().min(1).max(20000) }).strict().parse(request.body);
  return { request: await hubAssign(session, teamId.parse(request.params.teamId), body.role, body.message, randomUUID()) };
}));
app.post('/api/team-hub/:teamId/cancel', route(async (request, session) => hubCancel(session, teamId.parse(request.params.teamId), ref.parse(request.body).ref)));
app.post('/api/team-hub/:teamId/retry', route(async (request, session) => hubRetry(session, teamId.parse(request.params.teamId), ref.parse(request.body).ref)));
app.get('/api/team-hub/:teamId/proposals', route(async (request, session) => ({ proposals: await hubProposals(session, teamId.parse(request.params.teamId)) })));
app.post('/api/team-hub/:teamId/proposals/:proposalId/decide', route(async (request, session) => {
  const body = z.object({ decision: z.enum(['approve', 'reject']) }).strict().parse(request.body);
  return hubDecideProposal(session, teamId.parse(request.params.teamId), z.string().uuid().parse(request.params.proposalId), body.decision);
}));
app.delete('/api/team-hub/:teamId', route(async (request, session) => hubDelete(session, teamId.parse(request.params.teamId))));
