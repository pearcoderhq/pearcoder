// Covers: T17, T21 (durable hosted sessions)
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSessionId, signEvent } from '@pearcoderhq/protocol';
import { testEvent, testJoinEvent, testKey } from '@pearcoderhq/protocol/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { HostSession } from './host-session.js';
import { loadOrCreateDeviceIdentity } from './identity.js';
import { InvitationError } from './invitations.js';
import {
  hostedDir,
  listHostedSessions,
  lockHostedSession,
  openSessionStore,
  SessionBusyError,
} from './sqlite-store.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pearcoder-sqlite-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('persistent hosted sessions', () => {
  it('keeps history, participants, sequences and invitations across a restart', () => {
    const home = temp();
    const identity = loadOrCreateDeviceIdentity(home);
    const sessionId = newSessionId();
    const alice = testKey();

    let store = openSessionStore(home, sessionId);
    store.setMeta('session_name', 'auth-review');
    let session = HostSession.create({
      identity,
      displayName: 'Hana',
      sessionName: 'auth-review',
      sessionId,
      store,
      invitationPersistence: store,
    });
    const first = session.invite({ addresses: ['https://h.local:7777'], maxUses: 2 });
    const unused = session.invite({ addresses: ['https://h.local:7777'] });
    session.join(first.token, testJoinEvent(alice, sessionId, 'member', 'Alice'));
    session.log.append(
      signEvent(
        testEvent(alice.userId, { session_id: sessionId, payload: { text: 'before restart' } }),
        alice.privateKey,
      ),
    );
    session.invitations.revoke(unused.invitation.invite_id);
    const head = session.log.head;
    store.close();

    store = openSessionStore(home, sessionId);
    session = HostSession.create({
      identity,
      displayName: 'Hana',
      sessionName: 'auth-review',
      sessionId,
      store,
      invitationPersistence: store,
    });
    // The host's own join is not repeated; history and sequences continue.
    expect(session.log.head).toBe(head);
    expect(session.log.after(0).filter((e) => e.type === 'participant.joined')).toHaveLength(2);
    expect(session.log.participant(alice.userId)).toMatchObject({ role: 'member', active: true });
    const next = session.log.append(
      signEvent(
        testEvent(alice.userId, { session_id: sessionId, payload: { text: 'after restart' } }),
        alice.privateKey,
      ),
    );
    expect(next.event.sequence).toBe(head + 1);
    // The host's hash chain continues across the restart.
    expect(next.event.chain?.prev).toBe(session.log.after(head - 1)[0]?.chain?.hash);

    // Uses and revocations survived: one use left on the first, the second stays revoked.
    session.join(first.token, testJoinEvent(testKey(), sessionId, 'member'));
    expect(() => session.join(first.token, testJoinEvent(testKey(), sessionId, 'member'))).toThrow(
      InvitationError,
    );
    expect(() => session.join(unused.token, testJoinEvent(testKey(), sessionId, 'member'))).toThrow(
      /revoked/,
    );

    expect(listHostedSessions(home)).toEqual([
      expect.objectContaining({ sessionId, sessionName: 'auth-review' }),
    ]);
    if (process.platform !== 'win32') {
      expect(statSync(join(home, 'hosted', sessionId)).mode & 0o777).toBe(0o700);
    }
    store.close();
  });

  it('refuses to store out-of-order sequences', () => {
    const store = openSessionStore(temp(), newSessionId());
    const event = {
      ...testJoinEvent(testKey(), newSessionId(), 'host'),
      sequence: 2,
      received_at: '2026-10-23T00:00:00.000Z',
    };
    expect(() => store.append(event)).toThrow(/expected sequence 1/);
    store.close();
  });

  it('lets only one process host a persisted session, and takes over a stale lock', () => {
    const home = temp();
    const sessionId = newSessionId();
    openSessionStore(home, sessionId).close();
    const release = lockHostedSession(home, sessionId);
    expect(() => lockHostedSession(home, sessionId)).toThrow(SessionBusyError);
    release();
    lockHostedSession(home, sessionId)();

    // A lock whose process is gone does not block the next host.
    writeFileSync(join(hostedDir(home, sessionId), 'host.lock'), '2147483646');
    lockHostedSession(home, sessionId)();
  });
});
