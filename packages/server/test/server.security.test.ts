// Covers: T02, T04, T05, T06, T07, T16
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostSession, loadOrCreateDeviceIdentity } from '@pearcoderhq/core';
import {
  clientProofMessage,
  decodeInvitation,
  hostProofMessage,
  publicKeyFromRaw,
  type SessionId,
  signEvent,
  signProof,
  type UnsignedEvent,
  verifyProof,
  WS_AUTH_PREFIX,
  WS_PROTOCOL,
} from '@pearcoderhq/protocol';
import { type TestKey, testEvent, testJoinEvent, testKey } from '@pearcoderhq/protocol/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type RunningSessionServer, startSessionServer } from '../src/server.js';

const home = mkdtempSync(join(tmpdir(), 'pearcoder-server-'));
const identity = loadOrCreateDeviceIdentity(home);
const sessions = new Map<SessionId, HostSession>();
const session = HostSession.create({ identity, displayName: 'Host', sessionName: 'auth-review' });
sessions.set(session.sessionId, session);
const other = HostSession.create({ identity, displayName: 'Host', sessionName: 'other' });
sessions.set(other.sessionId, other);

let server: RunningSessionServer;
beforeAll(async () => {
  server = await startSessionServer({
    sessions,
    allowedOrigins: ['http://127.0.0.1:5173'],
    anonymousRateLimit: { burst: 1000, perSecond: 100 },
  });
});
afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

interface Res {
  status: number;
  body: { error?: { code: string } } & Record<string, unknown>;
}

function call(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; headers?: Record<string, string>; raw?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload =
      options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const req = httpRequest(
      `${server.url}${path}`,
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const base = (s: HostSession) => `/v1/sessions/${s.sessionId}`;

async function joinAs(role: 'member' | 'observer', s = session): Promise<TestKey> {
  const key = testKey();
  const { token } = s.invite({ addresses: [server.url], role });
  const res = await call('POST', `${base(s)}/join`, {
    body: { token, event: testJoinEvent(key, s.sessionId, role) },
  });
  expect(res.status).toBe(200);
  return key;
}

async function login(key: TestKey, s = session): Promise<string> {
  const clientNonce = randomBytes(16).toString('base64url');
  const challenge = await call('POST', `${base(s)}/challenge`, {
    body: { client_nonce: clientNonce },
  });
  expect(challenge.status).toBe(200);
  const hostNonce = challenge.body.host_nonce as string;
  const proof = signProof(
    clientProofMessage({
      sessionId: s.sessionId,
      hostUserId: s.hostUserId,
      userId: key.userId,
      hostNonce,
      clientNonce,
    }),
    key.privateKey,
  );
  const res = await call('POST', `${base(s)}/token`, {
    body: { user_id: key.userId, host_nonce: hostNonce, client_nonce: clientNonce, proof },
  });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const message = (key: TestKey, overrides: Partial<UnsignedEvent> = {}, s = session) =>
  signEvent(testEvent(key.userId, { session_id: s.sessionId, ...overrides }), key.privateKey);

describe('session server', () => {
  it('binds to loopback by default', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('runs the full join, login, post and read flow', async () => {
    const guest = await joinAs('member');
    const token = await login(guest);
    const posted = await call('POST', `${base(session)}/events`, { token, body: message(guest) });
    expect(posted).toMatchObject({ status: 200, body: { status: 'appended' } });
    const read = await call('GET', `${base(session)}/events?after=0`, { token });
    const types = (read.body.events as { type: string }[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['participant.joined', 'message.created']));
    const people = await call('GET', `${base(session)}/participants`, { token });
    expect((people.body.participants as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('proves the host identity named in the invitation (T02)', async () => {
    const { token } = session.invite({ addresses: [server.url] });
    const invitation = decodeInvitation(token);
    const clientNonce = randomBytes(16).toString('base64url');
    const res = await call('POST', `${base(session)}/challenge`, {
      body: { client_nonce: clientNonce },
    });
    const ok = verifyProof(
      hostProofMessage({
        sessionId: session.sessionId,
        hostUserId: invitation.host_user_id,
        clientNonce,
        hostNonce: res.body.host_nonce as string,
      }),
      res.body.host_proof as string,
      publicKeyFromRaw(invitation.host_public_key),
    );
    expect(ok).toBe(true);
  });

  it('long-poll returns as soon as a new event arrives', async () => {
    const guest = await joinAs('member');
    const token = await login(guest);
    const head = session.log.head;
    const started = Date.now();
    const pending = call('GET', `${base(session)}/events?after=${head}&wait=5000`, { token });
    setTimeout(() => session.log.append(message(guest)), 100);
    const res = await pending;
    expect((res.body.events as unknown[]).length).toBe(1);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('streams backlog and live events over WebSocket and acks appends', async () => {
    const guest = await joinAs('member');
    const token = await login(guest);
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}${base(session)}/stream?after=0`, [
      WS_PROTOCOL,
      `${WS_AUTH_PREFIX}${token}`,
    ]);
    const received: { type: string; sequence?: number; status?: string; code?: string }[] = [];
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      received.push({
        type: m.type,
        sequence: m.event?.sequence ?? m.sequence,
        status: m.status,
        code: m.code,
      });
    });
    await new Promise((resolve) => ws.once('open', resolve));
    expect(ws.protocol).toBe(WS_PROTOCOL);
    ws.send(JSON.stringify({ type: 'append', id: 1, event: message(guest) }));
    ws.send(JSON.stringify({ type: 'append', id: 2, event: message(guest, {}, other) }));
    ws.send('not json');
    await new Promise((resolve) => setTimeout(resolve, 300));
    ws.close();
    expect(received.some((m) => m.type === 'ready')).toBe(true);
    expect(received.filter((m) => m.type === 'ack')).toEqual([
      expect.objectContaining({ status: 'appended' }),
    ]);
    expect(received.filter((m) => m.type === 'error').map((m) => m.code)).toEqual([
      'WRONG_SESSION',
      'INVALID_MESSAGE',
    ]);
    const sequences = received.filter((m) => m.type === 'event').map((m) => m.sequence ?? 0);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

describe('rate limits on unauthenticated endpoints (T05, T07)', () => {
  it('throttles challenge floods per address', async () => {
    const limited = await startSessionServer({
      sessions,
      anonymousRateLimit: { burst: 3, perSecond: 0.001 },
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await new Promise<number>((resolve, reject) => {
          const req = httpRequest(
            `${limited.url}${base(session)}/challenge`,
            { method: 'POST', headers: { 'content-type': 'application/json' } },
            (r) => {
              r.resume();
              resolve(r.statusCode ?? 0);
            },
          );
          req.on('error', reject);
          req.end(JSON.stringify({ client_nonce: randomBytes(16).toString('base64url') }));
        });
        statuses.push(res);
      }
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('browser and DNS-rebinding protection (T16)', () => {
  it('rejects requests with a foreign Host header', async () => {
    const res = await call('GET', '/v1/health', {
      headers: { host: `evil.example:${server.port}` },
    });
    expect(res).toMatchObject({ status: 403, body: { error: { code: 'HOST_NOT_ALLOWED' } } });
  });

  it('rejects browser requests from other origins and accepts the allowed UI origin', async () => {
    const evil = await call('GET', '/v1/health', { headers: { origin: 'https://evil.example' } });
    expect(evil.body.error?.code).toBe('ORIGIN_NOT_ALLOWED');
    const ui = await call('GET', '/v1/health', { headers: { origin: 'http://127.0.0.1:5173' } });
    expect(ui.status).toBe(200);
  });

  it('refuses WebSocket upgrades from other origins', async () => {
    const guest = await joinAs('member');
    const token = await login(guest);
    const ws = new WebSocket(
      `${server.url.replace('http', 'ws')}${base(session)}/stream`,
      [WS_PROTOCOL, `${WS_AUTH_PREFIX}${token}`],
      {
        origin: 'https://evil.example',
      },
    );
    const status = await new Promise((resolve) =>
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)),
    );
    expect(status).toBe(403);
  });
});

describe('authentication and authorization', () => {
  it('requires a valid token for reads, writes and streams', async () => {
    expect((await call('GET', `${base(session)}/events`)).status).toBe(401);
    expect((await call('GET', `${base(session)}/events`, { token: 'nope' })).status).toBe(401);
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}${base(session)}/stream`, [
      WS_PROTOCOL,
    ]);
    const status = await new Promise((resolve) =>
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)),
    );
    expect(status).toBe(401);
  });

  it('rejects wrong proofs, replayed challenges and non-participants (T02, T04)', async () => {
    const guest = await joinAs('member');
    const clientNonce = randomBytes(16).toString('base64url');
    const challenge = await call('POST', `${base(session)}/challenge`, {
      body: { client_nonce: clientNonce },
    });
    const hostNonce = challenge.body.host_nonce as string;
    const input = {
      sessionId: session.sessionId,
      hostUserId: session.hostUserId,
      userId: guest.userId,
      hostNonce,
      clientNonce,
    };
    const mallory = testKey();
    const bad = await call('POST', `${base(session)}/token`, {
      body: {
        user_id: guest.userId,
        host_nonce: hostNonce,
        client_nonce: clientNonce,
        proof: signProof(clientProofMessage(input), mallory.privateKey),
      },
    });
    expect(bad.body.error?.code).toBe('PROOF_INVALID');
    const replay = await call('POST', `${base(session)}/token`, {
      body: {
        user_id: guest.userId,
        host_nonce: hostNonce,
        client_nonce: clientNonce,
        proof: signProof(clientProofMessage(input), guest.privateKey),
      },
    });
    expect(replay.body.error?.code).toBe('CHALLENGE_INVALID');

    const c2 = randomBytes(16).toString('base64url');
    const ch2 = await call('POST', `${base(session)}/challenge`, { body: { client_nonce: c2 } });
    const outsider = await call('POST', `${base(session)}/token`, {
      body: {
        user_id: mallory.userId,
        host_nonce: ch2.body.host_nonce,
        client_nonce: c2,
        proof: signProof(
          clientProofMessage({
            ...input,
            userId: mallory.userId,
            hostNonce: ch2.body.host_nonce as string,
            clientNonce: c2,
          }),
          mallory.privateKey,
        ),
      },
    });
    expect(outsider.body.error?.code).toBe('NOT_A_PARTICIPANT');
  });

  it('does not accept a token from another session', async () => {
    const guest = await joinAs('member', other);
    const otherToken = await login(guest, other);
    expect((await call('GET', `${base(session)}/events`, { token: otherToken })).status).toBe(401);
  });

  it('only accepts events authored by the token holder (T02)', async () => {
    const alice = await joinAs('member');
    const bob = await joinAs('member');
    const aliceToken = await login(alice);
    const res = await call('POST', `${base(session)}/events`, {
      token: aliceToken,
      body: message(bob),
    });
    expect(res).toMatchObject({ status: 403, body: { error: { code: 'ACTOR_MISMATCH' } } });
  });

  it('enforces roles over HTTP (T06)', async () => {
    const watcher = await joinAs('observer');
    const token = await login(watcher);
    const res = await call('POST', `${base(session)}/events`, { token, body: message(watcher) });
    expect(res).toMatchObject({ status: 403, body: { error: { code: 'FORBIDDEN_FOR_ROLE' } } });
  });

  it('revokes access when a participant leaves', async () => {
    const guest = await joinAs('member');
    const token = await login(guest);
    const left = await call('POST', `${base(session)}/events`, {
      token,
      body: message(guest, { type: 'participant.left', payload: {} }),
    });
    expect(left.status).toBe(200);
    expect((await call('GET', `${base(session)}/events`, { token })).status).toBe(401);
  });

  it('rejects oversized bodies and malformed JSON (T07, T10)', async () => {
    const guest = await joinAs('member');
    const token = await login(guest);
    // The server answers 413 and stops reading; Node's client may then report a reset before
    // the response. Either way the body is refused and nothing is appended.
    const headBefore = session.log.head;
    const outcome = await new Promise<string>((resolve) => {
      const req = httpRequest(`${server.url}${base(session)}/events`, {
        method: 'POST',
        // Own socket: the server closes it, so it must not return to the shared keep-alive pool.
        agent: false,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      });
      req.on('response', (res) => {
        res.resume();
        resolve(String(res.statusCode));
      });
      req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
      req.end(`"${'x'.repeat(400_000)}"`);
    });
    expect(['413', 'ECONNRESET', 'EPIPE']).toContain(outcome);
    expect(session.log.head).toBe(headBefore);
    const broken = await call('POST', `${base(session)}/events`, { token, raw: '{not json' });
    expect(broken.body.error?.code).toBe('INVALID_JSON');
  });

  it('returns safe errors for unknown sessions and routes', async () => {
    expect((await call('GET', '/v1/sessions/s_unknown/events')).body.error?.code).toBe(
      'SESSION_NOT_FOUND',
    );
    expect((await call('GET', '/nope')).body.error?.code).toBe('NOT_FOUND');
  });
});
