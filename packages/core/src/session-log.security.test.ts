// Covers: T02, T03, T04, T07, T10
import {
  newSessionId,
  type SignedEvent,
  signEvent,
  type UnsignedEvent,
} from '@pearcoderhq/protocol';
import { testEvent, testJoinEvent, testKey } from '@pearcoderhq/protocol/testing';
import { describe, expect, it } from 'vitest';
import { EventRejectedError, SessionLog } from './session-log.js';

function setup() {
  const sessionId = newSessionId();
  const log = new SessionLog({
    sessionId,
    now: () => new Date('2026-10-22T10:00:05.000Z'),
    maxEventBytes: 4096,
  });
  const alice = testKey();
  const mallory = testKey();
  log.admit(testJoinEvent(alice, sessionId, 'member'), 'member');
  log.admit(testJoinEvent(mallory, sessionId, 'member'), 'member');
  const event = (overrides: Partial<UnsignedEvent> = {}) =>
    testEvent(alice.userId, { session_id: sessionId, ...overrides });
  return { log, sessionId, alice, mallory, event };
}

function rejection(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof EventRejectedError) return error.code;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('SessionLog', () => {
  it('assigns increasing sequences and replays after a cursor', () => {
    const { log, alice, event } = setup();
    const a = log.append(signEvent(event(), alice.privateKey));
    const b = log.append(signEvent(event(), alice.privateKey));
    expect([a.status, a.event.sequence, b.event.sequence]).toEqual(['appended', 3, 4]);
    expect(a.event.received_at).toBe('2026-10-22T10:00:05.000Z');
    expect(log.after(3).map((e) => e.id)).toEqual([b.event.id]);
    expect(log.after(4)).toEqual([]);
    expect(log.head).toBe(4);
  });

  it('treats a resent identical event as a duplicate without a new sequence (T04)', () => {
    const { log, alice, event } = setup();
    const signed = signEvent(event(), alice.privateKey);
    log.append(signed);
    const again = log.append(JSON.parse(JSON.stringify(signed)));
    expect(again.status).toBe('duplicate');
    expect(again.event.sequence).toBe(3);
    expect(log.head).toBe(3);
  });

  it('rejects a different event reusing an existing id (T04)', () => {
    const { log, alice, event } = setup();
    const first = signEvent(event(), alice.privateKey);
    log.append(first);
    const reuse = signEvent(event({ id: first.id, payload: { text: 'other' } }), alice.privateKey);
    expect(rejection(() => log.append(reuse))).toBe('EVENT_ID_CONFLICT');
  });

  it('rejects impersonation: claiming to be alice with mallory key (T02)', () => {
    const { log, mallory, event } = setup();
    expect(rejection(() => log.append(signEvent(event(), mallory.privateKey)))).toBe(
      'BAD_SIGNATURE',
    );
  });

  it('rejects tampered events (T03)', () => {
    const { log, alice, event } = setup();
    const signed = signEvent(event(), alice.privateKey);
    const tampered: SignedEvent = { ...signed, payload: { text: 'tampered' } };
    expect(rejection(() => log.append(tampered))).toBe('BAD_SIGNATURE');
  });

  it('rejects events from non-participants and for other sessions', () => {
    const { log, event } = setup();
    const outsider = testKey();
    const fromOutsider = signEvent(
      { ...event(), actor_user_id: outsider.userId },
      outsider.privateKey,
    );
    expect(rejection(() => log.append(fromOutsider))).toBe('UNKNOWN_PARTICIPANT');
    const { alice } = setup();
    const otherSession = signEvent(testEvent(alice.userId), alice.privateKey);
    expect(rejection(() => log.append(otherSession))).toBe('WRONG_SESSION');
  });

  it('rejects oversized events (T07)', () => {
    const { log, alice, event } = setup();
    const big = signEvent(event({ payload: { text: 'x'.repeat(5000) } }), alice.privateKey);
    expect(rejection(() => log.append(big))).toBe('EVENT_TOO_LARGE');
  });

  it('rejects malformed input and invalid known payloads (T10)', () => {
    const { log, alice, event } = setup();
    for (const garbage of [null, 42, 'event', [], { id: 'x' }, { __proto__: { admin: true } }]) {
      expect(rejection(() => log.append(garbage))).toBe('INVALID_EVENT');
    }
    const badPayload = signEvent(event({ payload: { text: '' } }), alice.privateKey);
    expect(rejection(() => log.append(badPayload))).toBe('INVALID_PAYLOAD');
  });

  it('accepts unknown event types with their unknown fields intact', () => {
    const { log, alice, event } = setup();
    const future = signEvent(
      { ...event({ type: 'future.thing', payload: { x: 1 } }), extra: 'kept' },
      alice.privateKey,
    );
    const { event: stored } = log.append(future);
    expect(stored).toMatchObject({ type: 'future.thing', extra: 'kept', payload: { x: 1 } });
  });

  it('rejects events from a newer protocol version', () => {
    const { log, alice, event } = setup();
    expect(rejection(() => log.append(signEvent(event({ version: 99 }), alice.privateKey)))).toBe(
      'UNSUPPORTED_VERSION',
    );
  });

  it('returns copies, so callers cannot mutate the log', () => {
    const { log, alice, event } = setup();
    log.append(signEvent(event(), alice.privateKey));
    const [copy] = log.after(2);
    if (copy) copy.payload.text = 'mutated';
    expect(log.after(2)[0]?.payload.text).toBe('hello');
  });
});

describe('host-assigned fields', () => {
  it('ignores sequence and received_at supplied by the sender', () => {
    const { log, alice, event } = setup();
    const signed = signEvent(event(), alice.privateKey);
    const { event: stored } = log.append({
      ...signed,
      sequence: 999,
      received_at: '2000-01-01T00:00:00.000Z',
    });
    expect(stored.sequence).toBe(3);
    expect(stored.received_at).toBe('2026-10-22T10:00:05.000Z');
    expect(log.append({ ...signed, sequence: 5 }).status).toBe('duplicate');
  });
});
