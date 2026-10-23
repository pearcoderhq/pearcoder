// Covers: T01, T06, T07 (requests, findings, context packages)
import {
  newSessionId,
  signEvent,
  type UnsignedEvent,
  withContextPackageHash,
} from '@pearcoderhq/protocol';
import { type TestKey, testEvent, testJoinEvent, testKey } from '@pearcoderhq/protocol/testing';
import { describe, expect, it } from 'vitest';
import { EventRejectedError, SessionLog } from './session-log.js';

function setup() {
  const sessionId = newSessionId();
  const clock = { ms: Date.parse('2026-10-23T10:00:00.000Z') };
  const log = new SessionLog({ sessionId, now: () => new Date(clock.ms) });
  const host = testKey();
  const alice = testKey();
  const bob = testKey();
  const watcher = testKey();
  log.admit(testJoinEvent(host, sessionId, 'host'), 'host');
  log.admit(testJoinEvent(alice, sessionId, 'member'), 'member');
  log.admit(testJoinEvent(bob, sessionId, 'member'), 'member');
  log.admit(testJoinEvent(watcher, sessionId, 'observer'), 'observer');
  const send = (key: TestKey, overrides: Partial<UnsignedEvent>) =>
    log.append(
      signEvent(testEvent(key.userId, { session_id: sessionId, ...overrides }), key.privateKey),
    );
  return { log, host, alice, bob, watcher, send, clock };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof EventRejectedError) return error.code;
    throw error;
  }
  return 'accepted';
}

const pkg = (overrides: Record<string, unknown> = {}) =>
  withContextPackageHash({
    title: 'Auth spec',
    objective: 'Find races in token rotation',
    constraints: ['No schema changes'],
    paths: ['src/token.ts'],
    excerpts: [],
    body: '# Spec\nRefresh tokens rotate on use.',
    ...overrides,
  });

describe('context packages', () => {
  it('accepts a package whose hash matches and rejects a tampered one', () => {
    const { send, alice } = setup();
    expect(code(() => send(alice, { type: 'context_package.published', payload: pkg() }))).toBe(
      'accepted',
    );
    const tampered = { ...pkg(), body: 'changed after hashing' };
    expect(code(() => send(alice, { type: 'context_package.published', payload: tampered }))).toBe(
      'INVALID_PAYLOAD',
    );
  });

  it('allows packages up to 256 KiB while ordinary events stay at 64 KiB', () => {
    const { send, alice } = setup();
    const big = pkg({ body: 'x'.repeat(150_000) });
    expect(code(() => send(alice, { type: 'context_package.published', payload: big }))).toBe(
      'accepted',
    );
    expect(
      code(() => send(alice, { type: 'message.created', payload: { text: 'x'.repeat(15_000) } })),
    ).toBe('accepted');
    const huge = pkg({
      body: 'x'.repeat(199_000),
      excerpts: [{ path: 'a', text: 'y'.repeat(64_000) }],
    });
    expect(code(() => send(alice, { type: 'context_package.published', payload: huge }))).toBe(
      'EVENT_TOO_LARGE',
    );
  });
});

describe('requests (informational only)', () => {
  it('links a request to participants and an existing package', () => {
    const { send, alice, bob } = setup();
    const published = send(alice, { type: 'context_package.published', payload: pkg() });
    const request = send(alice, {
      type: 'request.created',
      payload: {
        to: [bob.userId],
        kind: 'review',
        title: 'Review the auth spec',
        context_package: published.event.id,
      },
    });
    expect(request.status).toBe('appended');
  });

  it('rejects requests to strangers or to missing packages', () => {
    const { send, alice } = setup();
    const stranger = testKey();
    expect(
      code(() =>
        send(alice, {
          type: 'request.created',
          payload: { to: [stranger.userId], kind: 'review', title: 'x' },
        }),
      ),
    ).toBe('INVALID_REFERENCE');
    expect(
      code(() =>
        send(alice, {
          type: 'request.created',
          payload: {
            to: [alice.userId],
            kind: 'review',
            title: 'x',
            context_package: '00000000-0000-4000-8000-000000000000',
          },
        }),
      ),
    ).toBe('INVALID_REFERENCE');
  });

  it('lets only the requester or an addressee resolve a request', () => {
    const { send, alice, bob, host } = setup();
    const request = send(alice, {
      type: 'request.created',
      payload: { to: [bob.userId], kind: 'review', title: 'x' },
    });
    const resolve = (key: TestKey) =>
      code(() =>
        send(key, {
          type: 'request.resolved',
          payload: { request: request.event.id, resolution: 'accepted' },
        }),
      );
    expect(resolve(host)).toBe('NOT_ADDRESSEE');
    expect(resolve(bob)).toBe('accepted');
    expect(resolve(alice)).toBe('accepted');
  });

  it('keeps observers read-only for requests, packages and findings', () => {
    const { send, watcher, alice } = setup();
    expect(
      code(() =>
        send(watcher, {
          type: 'request.created',
          payload: { to: [alice.userId], kind: 'review', title: 'x' },
        }),
      ),
    ).toBe('FORBIDDEN_FOR_ROLE');
    expect(code(() => send(watcher, { type: 'context_package.published', payload: pkg() }))).toBe(
      'FORBIDDEN_FOR_ROLE',
    );
    expect(
      code(() =>
        send(watcher, {
          type: 'review.finding',
          payload: { title: 't', severity: 'low', body: 'b' },
        }),
      ),
    ).toBe('FORBIDDEN_FOR_ROLE');
  });

  it('limits request floods per participant (loop guard)', () => {
    const { send, alice, bob, clock } = setup();
    const ask = () =>
      code(() =>
        send(alice, {
          type: 'request.created',
          payload: { to: [bob.userId], kind: 'question', title: 'q' },
        }),
      );
    for (let i = 0; i < 10; i++) expect(ask()).toBe('accepted');
    expect(ask()).toBe('RATE_LIMITED');
    clock.ms += 6 * 60 * 1000;
    expect(ask()).toBe('accepted');
  });
});

describe('review findings', () => {
  it('accepts findings that reference real requests and packages, with agent attribution', () => {
    const { send, alice, bob } = setup();
    const published = send(alice, { type: 'context_package.published', payload: pkg() });
    const request = send(alice, {
      type: 'request.created',
      payload: { to: [bob.userId], kind: 'review', title: 'x' },
    });
    const finding = send(bob, {
      type: 'review.finding',
      actor_agent_id: 'a_claudecode1',
      payload: {
        title: 'rotate() is check-then-act',
        severity: 'high',
        body: 'Two concurrent calls both pass the revoked check.',
        request: request.event.id,
        context_package: published.event.id,
        location: { path: 'src/token.ts', start_line: 3, end_line: 10 },
      },
    });
    expect(finding.event).toMatchObject({
      actor_agent_id: 'a_claudecode1',
      type: 'review.finding',
    });
    expect(
      code(() =>
        send(bob, {
          type: 'review.finding',
          payload: { title: 't', severity: 'low', body: 'b', request: published.event.id },
        }),
      ),
    ).toBe('INVALID_REFERENCE');
  });
});

describe('decisions and finding resolutions', () => {
  it('lets only the finding author, the requester or the host resolve a finding', () => {
    const { send, alice, bob, host } = setup();
    const carol = testKey();
    const request = send(alice, {
      type: 'request.created',
      payload: { to: [bob.userId], kind: 'review', title: 'x' },
    });
    const finding = send(bob, {
      type: 'review.finding',
      payload: { title: 't', severity: 'high', body: 'b', request: request.event.id },
    });
    const resolveAs = (key: TestKey) =>
      code(() =>
        send(key, {
          type: 'finding.resolved',
          payload: { finding: finding.event.id, resolution: 'fixed' },
        }),
      );
    expect(resolveAs(carol)).toBe('UNKNOWN_PARTICIPANT');
    // A member who neither wrote the finding nor asked for it cannot close it.
    const unrequested = send(bob, {
      type: 'review.finding',
      payload: { title: 'u', severity: 'low', body: 'b' },
    });
    expect(
      code(() =>
        send(alice, {
          type: 'finding.resolved',
          payload: { finding: unrequested.event.id, resolution: 'invalid' },
        }),
      ),
    ).toBe('NOT_ADDRESSEE');
    expect(resolveAs(bob)).toBe('accepted');
    expect(resolveAs(alice)).toBe('accepted');
    expect(resolveAs(host)).toBe('accepted');
  });

  it('records stances from anyone and outcomes only from the proposer or host', () => {
    const { send, alice, bob, host, watcher } = setup();
    const proposal = send(alice, {
      type: 'decision.proposed',
      payload: {
        title: 'Use compare-and-swap',
        decision: 'Claim the token with a conditional UPDATE',
      },
    });
    const id = proposal.event.id;
    expect(
      code(() => send(bob, { type: 'decision.vote', payload: { decision: id, stance: 'agree' } })),
    ).toBe('accepted');
    expect(
      code(() =>
        send(watcher, { type: 'decision.vote', payload: { decision: id, stance: 'agree' } }),
      ),
    ).toBe('FORBIDDEN_FOR_ROLE');
    expect(
      code(() =>
        send(bob, { type: 'decision.resolved', payload: { decision: id, outcome: 'accepted' } }),
      ),
    ).toBe('NOT_ADDRESSEE');
    expect(
      code(() =>
        send(host, { type: 'decision.resolved', payload: { decision: id, outcome: 'accepted' } }),
      ),
    ).toBe('accepted');
    expect(
      code(() =>
        send(bob, { type: 'decision.vote', payload: { decision: id, stance: 'disagree' } }),
      ),
    ).toBe('DECISION_CLOSED');
    const outcome = (who: typeof host, value: string) =>
      code(() =>
        send(who, { type: 'decision.resolved', payload: { decision: id, outcome: value } }),
      );
    expect(outcome(host, 'rejected')).toBe('DECISION_CLOSED');
    expect(outcome(alice, 'superseded')).toBe('accepted');
    expect(outcome(host, 'superseded')).toBe('DECISION_CLOSED');
    expect(
      code(() =>
        send(alice, {
          type: 'decision.proposed',
          payload: { title: 'x', decision: 'y', related: ['00000000-0000-4000-8000-000000000000'] },
        }),
      ),
    ).toBe('INVALID_REFERENCE');
  });

  it('accepts mentions of participants only', () => {
    const { send, alice, bob } = setup();
    const say = (payload: Record<string, unknown>) =>
      code(() =>
        send(alice, { type: 'message.created', payload: { text: '@Bob look', ...payload } }),
      );
    expect(say({ mentions: [bob.userId] })).toBe('accepted');
    expect(say({ agent_mentions: [{ user: bob.userId, agent: 'claude-code' }] })).toBe('accepted');
    expect(say({ mentions: [testKey().userId] })).toBe('INVALID_REFERENCE');
    expect(say({ agent_mentions: [{ user: testKey().userId, agent: 'codex' }] })).toBe(
      'INVALID_REFERENCE',
    );
  });
});
