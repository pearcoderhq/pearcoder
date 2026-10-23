// Covers: T06, T07
import { newSessionId, signEvent, type UnsignedEvent } from '@pearcoderhq/protocol';
import { type TestKey, testEvent, testJoinEvent, testKey } from '@pearcoderhq/protocol/testing';
import { describe, expect, it } from 'vitest';
import { canAppend } from './acl.js';
import { RateLimiter } from './rate-limit.js';
import { EventRejectedError, SessionLog } from './session-log.js';
import { MemoryEventStore } from './store.js';

function rejection(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof EventRejectedError) return error.code;
    throw error;
  }
  return 'accepted';
}

function setup(options: { clock?: { ms: number } } = {}) {
  const sessionId = newSessionId();
  const clock = options.clock ?? { ms: Date.parse('2026-10-22T10:00:00.000Z') };
  const store = new MemoryEventStore();
  const log = new SessionLog({ sessionId, store, now: () => new Date(clock.ms) });
  const host = testKey();
  const member = testKey();
  const observer = testKey();
  log.admit(testJoinEvent(host, sessionId, 'host'), 'host');
  log.admit(testJoinEvent(member, sessionId, 'member'), 'member');
  log.admit(testJoinEvent(observer, sessionId, 'observer'), 'observer');
  const send = (key: TestKey, overrides: Partial<UnsignedEvent> = {}) =>
    log.append(
      signEvent(testEvent(key.userId, { session_id: sessionId, ...overrides }), key.privateKey),
    );
  return { log, store, sessionId, host, member, observer, send, clock };
}

describe('role permissions (T06)', () => {
  it('matches the ACL matrix', () => {
    expect(canAppend('host', 'message.created')).toBe(true);
    expect(canAppend('member', 'message.created')).toBe(true);
    expect(canAppend('observer', 'message.created')).toBe(false);
    expect(canAppend('observer', 'presence.changed')).toBe(true);
    for (const role of ['host', 'member', 'observer'] as const) {
      expect(canAppend(role, 'participant.joined')).toBe(false);
    }
    expect(canAppend('member', 'future.thing')).toBe(true);
    expect(canAppend('observer', 'future.thing')).toBe(false);
  });

  it('lets observers watch but not post', () => {
    const { send, observer } = setup();
    expect(rejection(() => send(observer))).toBe('FORBIDDEN_FOR_ROLE');
    expect(
      rejection(() => send(observer, { type: 'presence.changed', payload: { state: 'online' } })),
    ).toBe('accepted');
  });

  it('never lets a participant inject participant.joined through append', () => {
    const { send, member, sessionId, log } = setup();
    const newcomer = testKey();
    expect(rejection(() => log.append(testJoinEvent(newcomer, sessionId, 'host')))).toBe(
      'UNKNOWN_PARTICIPANT',
    );
    expect(
      rejection(() =>
        send(member, {
          type: 'participant.joined',
          payload: testJoinEvent(member, sessionId, 'host').payload,
        }),
      ),
    ).toBe('FORBIDDEN_FOR_ROLE');
  });

  it('rejects joins whose role, key or actor do not match the grant', () => {
    const { log, sessionId } = setup();
    const a = testKey();
    expect(rejection(() => log.admit(testJoinEvent(a, sessionId, 'host'), 'member'))).toBe(
      'INVALID_JOIN',
    );
    const b = testKey();
    const join = testJoinEvent(b, sessionId, 'member');
    const swappedKey = { ...join, payload: testJoinEvent(a, sessionId, 'member').payload };
    expect(rejection(() => log.admit(swappedKey, 'member'))).toBe('INVALID_JOIN');
    expect(rejection(() => log.admit(join, 'member'))).toBe('accepted');
    expect(rejection(() => log.admit(testJoinEvent(b, sessionId, 'member'), 'member'))).toBe(
      'INVALID_JOIN',
    );
  });

  it('stops accepting events from a participant who left', () => {
    const { send, member } = setup();
    expect(rejection(() => send(member, { type: 'participant.left', payload: {} }))).toBe(
      'accepted',
    );
    expect(rejection(() => send(member))).toBe('UNKNOWN_PARTICIPANT');
  });
});

describe('rate limits (T07)', () => {
  it('limits bursts per participant and refills over time', () => {
    const clock = { ms: Date.parse('2026-10-22T10:00:00.000Z') };
    const { send, member, host } = setup({ clock });
    for (let i = 0; i < 20; i++) expect(rejection(() => send(member))).toBe('accepted');
    expect(rejection(() => send(member))).toBe('RATE_LIMITED');
    expect(rejection(() => send(host))).toBe('accepted');
    clock.ms += 1000;
    expect(rejection(() => send(member))).toBe('accepted');
  });

  it('token bucket refills at the sustained rate', () => {
    let now = 0;
    const limiter = new RateLimiter({ burst: 2, perSecond: 1 }, () => now);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([true, true, false]);
    now += 1000;
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
  });
});

describe('subscriptions and persistence', () => {
  it('notifies subscribers of new events only and survives a throwing subscriber', () => {
    const { log, send, member } = setup();
    const seen: number[] = [];
    log.subscribe(() => {
      throw new Error('bad subscriber');
    });
    const unsubscribe = log.subscribe((e) => seen.push(e.sequence));
    const signed = signEvent(
      testEvent(member.userId, { session_id: log.sessionId }),
      member.privateKey,
    );
    log.append(signed);
    log.append(signed);
    unsubscribe();
    send(member);
    expect(seen).toEqual([4]);
  });

  it('rebuilds participants and roles from an existing store', () => {
    const { store, sessionId, send, member, observer } = setup();
    send(member);
    send(member, { type: 'participant.left', payload: {} });
    const reopened = new SessionLog({ sessionId, store });
    expect(reopened.participant(observer.userId)).toMatchObject({ role: 'observer', active: true });
    expect(reopened.participant(member.userId)).toMatchObject({ active: false });
    expect(
      rejection(() =>
        reopened.append(
          signEvent(testEvent(observer.userId, { session_id: sessionId }), observer.privateKey),
        ),
      ),
    ).toBe('FORBIDDEN_FOR_ROLE');
  });
});
