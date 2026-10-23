// Covers: T02, T04, T08, T21
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type DeviceIdentity, HostSession, loadOrCreateDeviceIdentity } from '@pearcoderhq/core';
import {
  decodeInvitation,
  newEventId,
  PROTOCOL_VERSION,
  type SequencedEvent,
  type SessionId,
  signEvent,
} from '@pearcoderhq/protocol';
import { loadOrCreateTls, startSessionServer, type TlsMaterial } from '@pearcoderhq/server';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { type ClientStatus, joinSession, resolveEndpoint, SessionClient } from '../src/client.js';
import { FileCursorStore } from '../src/cursor.js';
import type { ClientError } from '../src/errors.js';
import { pinnedAgent } from '../src/tls.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearcoder-client-'));
  dirs.push(dir);
  return dir;
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const fast = { minMs: 20, maxMs: 200 };

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await delay(20);
  }
}

async function hostSetup(
  options: { port?: number; tls?: TlsMaterial; session?: HostSession } = {},
) {
  const hostIdentity = loadOrCreateDeviceIdentity(tempDir());
  const tls = options.tls ?? (await loadOrCreateTls(tempDir(), { hosts: ['127.0.0.1'] }));
  const session =
    options.session ??
    HostSession.create({ identity: hostIdentity, displayName: 'Host', sessionName: 'auth-review' });
  const sessions = new Map<SessionId, HostSession>([[session.sessionId, session]]);
  const server = await startSessionServer({
    sessions,
    tls,
    ...(options.port ? { port: options.port } : {}),
  });
  cleanups.push(() => server.close());
  const invite = (role: 'member' | 'observer' = 'member', fingerprint = tls.fingerprint) =>
    session.invite({ addresses: [server.url], tlsFingerprint: fingerprint, role, maxUses: 1 })
      .token;
  return { session, server, tls, invite, sessions, hostIdentity };
}

function hostSay(session: HostSession, identity: DeviceIdentity, text: string) {
  return session.log.append(
    signEvent(
      {
        id: newEventId(),
        session_id: session.sessionId,
        timestamp: new Date().toISOString(),
        actor_user_id: identity.userId,
        type: 'message.created',
        thread_id: 'main',
        version: PROTOCOL_VERSION,
        payload: { text },
      },
      identity.privateKey,
    ),
  );
}

async function connectedGuest(token: string, home = tempDir()) {
  const identity = loadOrCreateDeviceIdentity(home);
  const joined = await joinSession(token, identity, 'Guest');
  const events: SequencedEvent[] = [];
  const statuses: { status: ClientStatus; code?: string }[] = [];
  const client = new SessionClient({
    host: joined.host,
    endpoint: joined.endpoint,
    identity,
    cursors: new FileCursorStore(home),
    backoff: fast,
    onEvent: (e) => events.push(e),
    onStatus: (status, error) => statuses.push({ status, ...(error ? { code: error.code } : {}) }),
  });
  client.start();
  cleanups.push(() => client.stop());
  await until(() => statuses.some((s) => s.status === 'online'));
  return { client, events, statuses, identity, home };
}

const texts = (events: SequencedEvent[]) =>
  events.filter((e) => e.type === 'message.created').map((e) => e.payload.text);

describe('SessionClient', () => {
  it('joins over pinned TLS, streams history and live events, and sends messages', async () => {
    const { session, invite, hostIdentity } = await hostSetup();
    hostSay(session, hostIdentity, 'before join');
    const alice = await connectedGuest(invite());
    const bob = await connectedGuest(invite());

    await alice.client.say('hi from alice');
    hostSay(session, hostIdentity, 'hi from host');
    await until(() => texts(bob.events).length === 3);
    expect(texts(bob.events)).toEqual(['before join', 'hi from alice', 'hi from host']);
    await until(() => texts(alice.events).length === 3);
    // Ordered, gap-free, no duplicates.
    expect(alice.events.map((e) => e.sequence)).toEqual(
      Array.from({ length: alice.events.length }, (_, i) => i + 1),
    );
  });

  it('recovers from a host restart without duplicates or gaps (T21)', async () => {
    const first = await hostSetup();
    const alice = await connectedGuest(first.invite());
    await alice.client.say('one');
    await first.server.close();

    // While the host's server is down, the session keeps going locally.
    hostSay(first.session, first.hostIdentity, 'during outage 1');
    hostSay(first.session, first.hostIdentity, 'during outage 2');
    await until(() => alice.statuses.some((s) => s.status === 'offline'));

    // Same session state, new process: tokens are gone, so the client must log in again.
    await hostSetup({ port: first.server.port, tls: first.tls, session: first.session });
    await until(() => texts(alice.events).length === 3, 10_000);
    hostSay(first.session, first.hostIdentity, 'after restart');
    await until(() => texts(alice.events).length === 4);
    expect(texts(alice.events)).toEqual([
      'one',
      'during outage 1',
      'during outage 2',
      'after restart',
    ]);
    const sequences = alice.events.map((e) => e.sequence);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => i + 1));
    expect(alice.client.cursor).toBe(first.session.log.head);
  });

  it('resumes from the persisted cursor after the client itself restarts', async () => {
    const { session, invite, hostIdentity } = await hostSetup();
    const alice = await connectedGuest(invite());
    hostSay(session, hostIdentity, 'seen');
    await until(() => texts(alice.events).length === 1);
    await alice.client.stop();
    hostSay(session, hostIdentity, 'missed while closed');

    const resumed: SequencedEvent[] = [];
    const again = new SessionClient({
      host: alice.client.host,
      endpoint: await resolveEndpoint(decodeInvitation(invite())),
      identity: alice.identity,
      cursors: new FileCursorStore(alice.home),
      backoff: fast,
      onEvent: (e) => resumed.push(e),
    });
    again.start();
    cleanups.push(() => again.stop());
    await until(() => resumed.length === 1);
    expect(texts(resumed)).toEqual(['missed while closed']);
  });

  it('retries appends idempotently and surfaces host rejections', async () => {
    const { invite } = await hostSetup();
    const watcher = await connectedGuest(invite('observer'));
    await expect(watcher.client.say('observers cannot post')).rejects.toMatchObject({
      code: 'FORBIDDEN_FOR_ROLE',
    });

    const alice = await connectedGuest(invite());
    const outcome = await alice.client.say('once');
    await until(() => alice.events.some((e) => e.sequence === outcome.sequence));
    const stored = alice.events.find((e) => e.sequence === outcome.sequence) as SequencedEvent;
    // Resending a stored copy (host fields included) is answered as a duplicate.
    const again = await alice.client.appendSigned(stored);
    expect(again).toEqual({ id: stored.id, status: 'duplicate', sequence: outcome.sequence });
  });
});

describe('host authenticity (T02, T08)', () => {
  it('refuses a host whose certificate does not match the invitation', async () => {
    const { invite } = await hostSetup();
    const other = await loadOrCreateTls(tempDir(), { hosts: ['127.0.0.1'] });
    const token = invite('member', other.fingerprint);
    await expect(
      joinSession(token, loadOrCreateDeviceIdentity(tempDir()), 'Guest'),
    ).rejects.toMatchObject({
      code: 'TLS_FINGERPRINT_MISMATCH',
    });
  });

  it('pins at the TLS layer: a pinned agent cannot talk to another server', async () => {
    const real = await hostSetup();
    const fake = await hostSetup();
    const agent = await pinnedAgent('127.0.0.1', real.server.port, real.tls.fingerprint);
    cleanups.push(() => agent.destroy());
    const { requestJson } = await import('../src/http.js');
    await expect(
      requestJson({ baseUrl: real.server.url, agent }, 'GET', '/v1/health'),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      requestJson({ baseUrl: fake.server.url, agent }, 'GET', '/v1/health'),
    ).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(
      requestJson({ baseUrl: real.server.url }, 'GET', '/v1/health'),
    ).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });

  it('stops when the host at the address cannot prove the invited identity', async () => {
    const real = await hostSetup();
    const token = real.invite();
    const invitation = decodeInvitation(token);
    // An impostor serves the same session id with a different device key and the same certificate.
    const impostorIdentity = loadOrCreateDeviceIdentity(tempDir());
    const impostorSession = HostSession.create({
      identity: impostorIdentity,
      displayName: 'Impostor',
      sessionName: 'auth-review',
      sessionId: invitation.session_id,
    });
    const impostor = await hostSetup({ tls: real.tls, session: impostorSession });
    const statuses: { status: ClientStatus; error?: ClientError }[] = [];
    const client = new SessionClient({
      host: invitation,
      endpoint: {
        baseUrl: impostor.server.url,
        agent: await pinnedAgent('127.0.0.1', impostor.server.port, real.tls.fingerprint),
      },
      identity: loadOrCreateDeviceIdentity(tempDir()),
      backoff: fast,
      onStatus: (status, error) => statuses.push({ status, ...(error ? { error } : {}) }),
    });
    client.start();
    cleanups.push(() => client.stop());
    await until(() => statuses.some((s) => s.status === 'stopped'));
    expect(statuses.find((s) => s.status === 'stopped')?.error?.code).toBe('HOST_PROOF_INVALID');
  });

  it('refuses plain HTTP to non-loopback addresses', async () => {
    const { session } = await hostSetup();
    const { token } = session.invite({ addresses: ['http://192.168.1.5:7777'] });
    await expect(resolveEndpoint(decodeInvitation(token))).rejects.toMatchObject({
      code: 'HOST_UNREACHABLE',
      message: expect.stringContaining('not loopback and not HTTPS'),
    });
  });
});
