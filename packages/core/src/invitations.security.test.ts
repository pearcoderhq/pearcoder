// Covers: T05, T06
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeInvitation, encodeInvitation, newSessionId } from '@pearcoderhq/protocol';
import { testJoinEvent, testKey } from '@pearcoderhq/protocol/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { HostSession } from './host-session.js';
import { loadOrCreateDeviceIdentity } from './identity.js';
import { InvitationError } from './invitations.js';
import { EventRejectedError } from './session-log.js';

const home = mkdtempSync(join(tmpdir(), 'pearcoder-invites-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const identity = loadOrCreateDeviceIdentity(home);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvitationError || error instanceof EventRejectedError) return error.code;
    throw error;
  }
  return 'accepted';
}

function setup() {
  const clock = { ms: Date.parse('2026-10-22T10:00:00.000Z') };
  const session = HostSession.create({
    identity,
    displayName: 'Host',
    sessionName: 'auth-review',
    now: () => new Date(clock.ms),
  });
  const invite = (
    opts: Parameters<HostSession['invite']>[0] = { addresses: ['https://192.168.1.5:7777'] },
  ) => session.invite(opts);
  return { session, clock, invite };
}

describe('invitations (T05)', () => {
  it('admits a joiner once and records them with the invited role', () => {
    const { session, invite } = setup();
    const { token } = invite({ addresses: ['https://192.168.1.5:7777'], role: 'observer' });
    const guest = testKey();
    const result = session.join(token, testJoinEvent(guest, session.sessionId, 'observer'));
    expect(result.status).toBe('appended');
    expect(session.log.participant(guest.userId)).toMatchObject({ role: 'observer' });
    expect(session.log.participant(session.hostUserId)).toMatchObject({ role: 'host' });
  });

  it('lets joiners verify who issued the invitation and where to connect', () => {
    const { session, invite } = setup();
    const { token } = invite({
      addresses: ['https://192.168.1.5:7777'],
      tlsFingerprint: `sha256:${'a'.repeat(64)}`,
    });
    const decoded = decodeInvitation(token);
    expect(decoded).toMatchObject({
      session_id: session.sessionId,
      session_name: 'auth-review',
      host_user_id: identity.userId,
      tls_fingerprint: `sha256:${'a'.repeat(64)}`,
    });
  });

  it('rejects a single-use invitation the second time, but answers a resent join', () => {
    const { session, invite } = setup();
    const { token } = invite();
    const first = testJoinEvent(testKey(), session.sessionId, 'member');
    expect(session.join(token, first).status).toBe('appended');
    expect(session.join(token, first).status).toBe('duplicate');
    expect(
      code(() => session.join(token, testJoinEvent(testKey(), session.sessionId, 'member'))),
    ).toBe('INVITE_EXHAUSTED');
  });

  it('does not burn an invitation on an invalid join attempt', () => {
    const { session, invite } = setup();
    const { token } = invite();
    const wrongRole = testJoinEvent(testKey(), session.sessionId, 'host');
    expect(code(() => session.join(token, wrongRole))).toBe('INVALID_JOIN');
    expect(session.join(token, testJoinEvent(testKey(), session.sessionId, 'member')).status).toBe(
      'appended',
    );
  });

  it('rejects expired and revoked invitations', () => {
    const { session, invite, clock } = setup();
    const expiring = invite({ addresses: ['https://h.local:7777'], ttlMs: 60_000 });
    const revoked = invite();
    session.invitations.revoke(revoked.invitation.invite_id);
    clock.ms += 61_000;
    const join = () => testJoinEvent(testKey(), session.sessionId, 'member');
    expect(code(() => session.join(expiring.token, join()))).toBe('INVITE_EXPIRED');
    expect(code(() => session.join(revoked.token, join()))).toBe('INVITE_REVOKED');
  });

  it('rejects tampered, malformed and foreign invitations', () => {
    const { session, invite } = setup();
    const { token } = invite();
    const join = () => testJoinEvent(testKey(), session.sessionId, 'member');

    const [body, sig] = token.slice(4).split('.') as [string, string];
    const content = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const elevated = Buffer.from(JSON.stringify({ ...content, max_uses: 100 })).toString(
      'base64url',
    );
    expect(code(() => session.join(`pc1_${elevated}.${sig}`, join()))).toBe('INVITE_BAD_SIGNATURE');
    const reordered = Buffer.from(
      JSON.stringify(Object.fromEntries(Object.entries(content).reverse())),
    ).toString('base64url');
    expect(code(() => session.join(`pc1_${reordered}.${sig}`, join()))).toBe('INVITE_MALFORMED');

    expect(code(() => session.join('pc1_garbage', join()))).toBe('INVITE_MALFORMED');
    expect(code(() => session.join('hello', join()))).toBe('INVITE_MALFORMED');

    // Validly signed by someone else's key for the same session: never issued by this host.
    const mallory = testKey();
    const forged = encodeInvitation(
      {
        session_id: session.sessionId,
        session_name: 'auth-review',
        addresses: ['https://evil.example'],
        role: 'member',
        expires_at: '2030-01-01T00:00:00.000Z',
        max_uses: 100,
      },
      mallory.privateKey,
    );
    expect(code(() => session.join(forged.token, join()))).toBe('INVITE_UNKNOWN');

    const otherSession = HostSession.create({
      identity,
      displayName: 'Host',
      sessionName: 'other',
    });
    const otherToken = otherSession.invite({ addresses: ['https://h.local:7777'] }).token;
    expect(code(() => session.join(otherToken, join()))).toBe('INVITE_WRONG_SESSION');
  });

  it('rejects a join event signed for another session', () => {
    const { session, invite } = setup();
    const { token } = invite();
    expect(
      code(() => session.join(token, testJoinEvent(testKey(), newSessionId(), 'member'))),
    ).toBe('WRONG_SESSION');
  });

  it('cannot issue host invitations', () => {
    const { session } = setup();
    expect(() =>
      session.invite({
        addresses: ['https://h.local:7777'],
        role: 'host' as unknown as 'member',
      }),
    ).toThrow();
  });
});
