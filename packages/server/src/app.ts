import type { HttpBindings } from '@hono/node-server';
import { type HostSession, type RateLimit, RateLimiter } from '@pearcoderhq/core';
import {
  clientProofMessage,
  hostProofMessage,
  MAX_ANY_EVENT_BYTES,
  PROTOCOL_VERSION,
  publicKeyFromRaw,
  type SequencedEvent,
  type SessionId,
  UserIdSchema,
  verifyProof,
} from '@pearcoderhq/protocol';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AuthState, SessionToken } from './auth-state.js';
import { HttpError, toErrorResponse } from './errors.js';
import { checkRequest, type GuardConfig } from './guards.js';

// Room for the largest event (a context package) plus JSON envelope overhead.
export const MAX_BODY_BYTES = MAX_ANY_EVENT_BYTES + 64 * 1024;
export const MAX_LONG_POLL_MS = 30_000;
// Per address, for join and login. Every CLI command logs in (challenge + token), so a burst of
// 60 lets someone run a few dozen commands in a row; logins are Ed25519 proofs, not guessable.
export const DEFAULT_ANONYMOUS_RATE_LIMIT: RateLimit = { burst: 60, perSecond: 5 };

export interface AppContext {
  sessions: ReadonlyMap<SessionId, HostSession>;
  auth: AuthState;
  guards: GuardConfig;
  now?: () => number;
  anonymousRateLimit?: RateLimit;
}

type Env = { Bindings: HttpBindings };

const NonceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const JoinBody = z.object({ token: z.string().max(4096), event: z.unknown() });
const ChallengeBody = z.object({ client_nonce: NonceSchema });
const InviteBody = z.object({
  role: z.enum(['member', 'observer']).default('member'),
  ttl_ms: z
    .number()
    .int()
    .min(60_000)
    .max(30 * 24 * 60 * 60 * 1000)
    .default(24 * 60 * 60 * 1000),
  max_uses: z.number().int().min(1).max(100).default(1),
});
const TokenBody = z.object({
  user_id: UserIdSchema,
  host_nonce: NonceSchema,
  client_nonce: NonceSchema,
  proof: z.base64url(),
});

export function createApp(ctx: AppContext): Hono<Env> {
  const app = new Hono<Env>();
  const now = ctx.now ?? Date.now;
  // Unauthenticated endpoints are rate limited per remote address (threat model T05, T07).
  const anonymousLimiter = new RateLimiter(
    ctx.anonymousRateLimit ?? DEFAULT_ANONYMOUS_RATE_LIMIT,
    now,
  );

  app.onError((error, c) => {
    const { status, body } = toErrorResponse(error);
    return c.json(body, status as 400);
  });

  app.use('*', async (c, next) => {
    const failure = checkRequest(ctx.guards, c.req.header('host'), c.req.header('origin'));
    if (failure) throw new HttpError(403, failure, 'request rejected');
    await next();
  });

  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new HttpError(413, 'BODY_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`);
      },
    }),
  );

  const limitAnonymous = (c: Context<Env>) => {
    const address = c.env.incoming.socket.remoteAddress ?? 'unknown';
    if (!anonymousLimiter.take(address))
      throw new HttpError(429, 'RATE_LIMITED', 'too many requests');
  };

  app.get('/v1/health', (c) => c.json({ ok: true, protocol_version: PROTOCOL_VERSION }));

  app.post('/v1/sessions/:id/join', async (c) => {
    limitAnonymous(c);
    const session = sessionFor(ctx, c.req.param('id'));
    const body = JoinBody.parse(await readJson(c));
    const result = session.join(body.token, body.event);
    return c.json({ status: result.status, event: result.event });
  });

  app.post('/v1/sessions/:id/challenge', async (c) => {
    limitAnonymous(c);
    const session = sessionFor(ctx, c.req.param('id'));
    const { client_nonce: clientNonce } = parseBody(ChallengeBody, await readJson(c));
    const { hostNonce, expiresAt } = ctx.auth.createChallenge(session.sessionId, clientNonce);
    const proof = session.signAsHost(
      hostProofMessage({
        sessionId: session.sessionId,
        hostUserId: session.hostUserId,
        clientNonce,
        hostNonce,
      }),
    );
    return c.json({
      host_user_id: session.hostUserId,
      host_nonce: hostNonce,
      host_proof: proof,
      expires_at: new Date(expiresAt).toISOString(),
    });
  });

  app.post('/v1/sessions/:id/token', async (c) => {
    limitAnonymous(c);
    const session = sessionFor(ctx, c.req.param('id'));
    const body = parseBody(TokenBody, await readJson(c));
    const challenge = ctx.auth.consumeChallenge(body.host_nonce);
    if (
      !challenge ||
      challenge.sessionId !== session.sessionId ||
      challenge.clientNonce !== body.client_nonce
    ) {
      throw new HttpError(401, 'CHALLENGE_INVALID', 'challenge is unknown, used or expired');
    }
    const participant = session.log.participant(body.user_id);
    if (!participant?.active) {
      throw new HttpError(403, 'NOT_A_PARTICIPANT', 'user is not an active participant');
    }
    const valid = verifyProof(
      clientProofMessage({
        sessionId: session.sessionId,
        hostUserId: session.hostUserId,
        userId: body.user_id,
        hostNonce: body.host_nonce,
        clientNonce: body.client_nonce,
      }),
      body.proof,
      publicKeyFromRaw(participant.publicKey),
    );
    if (!valid) throw new HttpError(401, 'PROOF_INVALID', 'proof does not verify');
    const { token, expiresAt } = ctx.auth.issueToken(session.sessionId, body.user_id);
    return c.json({ token, expires_at: new Date(expiresAt).toISOString() });
  });

  // Only the host may create invitations; the host's own CLI uses this while the host runs.
  app.post('/v1/sessions/:id/invitations', async (c) => {
    const session = sessionFor(ctx, c.req.param('id'));
    const token = authorize(ctx, c, session);
    if (session.log.participant(token.userId)?.role !== 'host') {
      throw new HttpError(403, 'FORBIDDEN_FOR_ROLE', 'only the host can invite');
    }
    const defaults = session.inviteDefaults;
    if (!defaults)
      throw new HttpError(409, 'INVITES_NOT_CONFIGURED', 'host has no invite addresses');
    const body = parseBody(InviteBody, await readJson(c));
    const issued = session.invite({
      ...defaults,
      role: body.role,
      ttlMs: body.ttl_ms,
      maxUses: body.max_uses,
    });
    return c.json(issued);
  });

  app.get('/v1/sessions/:id/participants', (c) => {
    const session = sessionFor(ctx, c.req.param('id'));
    authorize(ctx, c, session);
    return c.json({ participants: session.log.participants() });
  });

  app.get('/v1/sessions/:id/events', async (c) => {
    const session = sessionFor(ctx, c.req.param('id'));
    authorize(ctx, c, session);
    const after = intParam(c.req.query('after'), 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(c.req.query('limit'), 500, 1, 1000);
    const wait = intParam(c.req.query('wait'), 0, 0, MAX_LONG_POLL_MS);
    let events = session.log.after(after, limit);
    if (events.length === 0 && wait > 0) {
      events = await waitForEvents(session, after, limit, wait, c.req.raw.signal);
    }
    return c.json({ events, head: session.log.head });
  });

  app.post('/v1/sessions/:id/events', async (c) => {
    const session = sessionFor(ctx, c.req.param('id'));
    const token = authorize(ctx, c, session);
    const event = await readJson(c);
    assertActor(event, token);
    const result = session.log.append(event);
    return c.json({ status: result.status, sequence: result.event.sequence });
  });

  app.notFound(() => {
    throw new HttpError(404, 'NOT_FOUND', 'no such endpoint');
  });

  return app;
}

export function sessionFor(ctx: AppContext, id: string): HostSession {
  const session = ctx.sessions.get(id as SessionId);
  if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'no such session');
  return session;
}

export function resolveBearer(
  ctx: AppContext,
  token: string | undefined,
  session: HostSession,
): SessionToken {
  const entry = token ? ctx.auth.resolveToken(token) : undefined;
  if (!entry || entry.sessionId !== session.sessionId) {
    throw new HttpError(401, 'UNAUTHORIZED', 'missing or invalid session token');
  }
  // Tokens die with participation: a participant who left cannot keep reading.
  if (!session.log.participant(entry.userId)?.active) {
    throw new HttpError(401, 'UNAUTHORIZED', 'participant is no longer in the session');
  }
  return entry;
}

/** Events may only be submitted by the participant the session token belongs to. */
export function assertActor(event: unknown, token: SessionToken): void {
  const actor = (event as { actor_user_id?: unknown } | null)?.actor_user_id;
  if (actor !== token.userId) {
    throw new HttpError(403, 'ACTOR_MISMATCH', 'events must be authored by the token holder');
  }
}

function authorize(ctx: AppContext, c: Context<Env>, session: HostSession): SessionToken {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  return resolveBearer(ctx, token, session);
}

async function readJson(c: Context<Env>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'body is not valid JSON');
  }
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'INVALID_REQUEST', 'request body is invalid');
  return parsed.data;
}

function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'INVALID_REQUEST', 'invalid query parameter');
  }
  return value;
}

function waitForEvents(
  session: HostSession,
  after: number,
  limit: number,
  waitMs: number,
  signal: AbortSignal,
): Promise<SequencedEvent[]> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', finish);
      resolve(session.log.after(after, limit));
    };
    const unsubscribe = session.log.subscribe(finish);
    const timer = setTimeout(finish, waitMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}
