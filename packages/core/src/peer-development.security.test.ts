// Covers: T06, T07, T37, T39 (tasks, code refs, agent status)
import { newSessionId, signEvent, type UnsignedEvent } from '@pearcoderhq/protocol';
import { type TestKey, testEvent, testJoinEvent, testKey } from '@pearcoderhq/protocol/testing';
import { describe, expect, it } from 'vitest';
import { EventRejectedError, SessionLog } from './session-log.js';
import { MemoryEventStore } from './store.js';

function setup() {
  const sessionId = newSessionId();
  const log = new SessionLog({ sessionId });
  const host = testKey();
  const alice = testKey();
  const bob = testKey();
  const carol = testKey();
  const watcher = testKey();
  log.admit(testJoinEvent(host, sessionId, 'host'), 'host');
  log.admit(testJoinEvent(alice, sessionId, 'member'), 'member');
  log.admit(testJoinEvent(bob, sessionId, 'member'), 'member');
  log.admit(testJoinEvent(carol, sessionId, 'member'), 'member');
  log.admit(testJoinEvent(watcher, sessionId, 'observer'), 'observer');
  const send = (key: TestKey, overrides: Partial<UnsignedEvent>) =>
    log.append(
      signEvent(testEvent(key.userId, { session_id: sessionId, ...overrides }), key.privateKey),
    );
  return { log, sessionId, host, alice, bob, carol, watcher, send };
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

const SHA = 'a'.repeat(40);

describe('tasks', () => {
  it('lets the creator, the assignee and the host update a task, and nobody else', () => {
    const { send, host, alice, bob, carol } = setup();
    const task = send(alice, {
      type: 'task.created',
      payload: { title: 'Rotate tokens', assignee: { user: bob.userId, agent: 'claude-code' } },
    }).event.id;
    const update = (who: TestKey) =>
      code(() => send(who, { type: 'task.updated', payload: { task, status: 'in_progress' } }));
    expect(update(alice)).toBe('accepted');
    expect(update(bob)).toBe('accepted');
    expect(update(host)).toBe('accepted');
    expect(update(carol)).toBe('NOT_ADDRESSEE');
    // Reassigning moves the right to update with it.
    send(alice, { type: 'task.updated', payload: { task, assignee: { user: carol.userId } } });
    expect(update(carol)).toBe('accepted');
  });

  it('only assigns to participants, only updates tasks, and keeps observers out', () => {
    const { send, alice, watcher } = setup();
    expect(
      code(() =>
        send(alice, {
          type: 'task.created',
          payload: { title: 'x', assignee: { user: testKey().userId } },
        }),
      ),
    ).toBe('INVALID_REFERENCE');
    const message = send(alice, { type: 'message.created', payload: { text: 'hi' } }).event.id;
    expect(
      code(() => send(alice, { type: 'task.updated', payload: { task: message, status: 'done' } })),
    ).toBe('INVALID_REFERENCE');
    expect(code(() => send(watcher, { type: 'task.created', payload: { title: 'x' } }))).toBe(
      'FORBIDDEN_FOR_ROLE',
    );
    expect(code(() => send(alice, { type: 'task.updated', payload: { task: message } }))).toBe(
      'INVALID_PAYLOAD',
    );
  });

  it('keeps who may update a task after the log is reloaded', () => {
    const { log, sessionId, alice, bob, carol } = setup();
    const send = (key: TestKey, overrides: Partial<UnsignedEvent>, target = log) =>
      target.append(
        signEvent(testEvent(key.userId, { session_id: sessionId, ...overrides }), key.privateKey),
      );
    const task = send(alice, {
      type: 'task.created',
      payload: { title: 'x', assignee: { user: bob.userId } },
    }).event.id;
    const store = new MemoryEventStore();
    for (const event of log.after(0, 10_000)) store.append(event);
    const reloaded = new SessionLog({ sessionId, store });
    expect(
      code(() =>
        send(carol, { type: 'task.updated', payload: { task, status: 'done' } }, reloaded),
      ),
    ).toBe('NOT_ADDRESSEE');
    expect(
      code(() => send(bob, { type: 'task.updated', payload: { task, status: 'done' } }, reloaded)),
    ).toBe('accepted');
  });
});

describe('code refs', () => {
  const ref = (overrides: Record<string, unknown> = {}) => ({
    repo: { name: 'pearcoder', url: 'https://github.com/pearcoderhq/pearcoder' },
    branch: 'feat/tokens',
    commit: SHA,
    summary: 'Rotate refresh tokens on use',
    ...overrides,
  });

  it('accepts a full commit id and refuses branch names, short ids and ranges as commits', () => {
    const { send, alice } = setup();
    expect(code(() => send(alice, { type: 'code_ref.published', payload: ref() }))).toBe(
      'accepted',
    );
    for (const commit of ['main', 'abc1234', `${SHA}..${SHA}`, 'A'.repeat(40)]) {
      expect(
        code(() => send(alice, { type: 'code_ref.published', payload: ref({ commit }) })),
      ).toBe('INVALID_PAYLOAD');
    }
    for (const branch of ['-f', '../x', 'a..b', 'x.lock']) {
      expect(
        code(() => send(alice, { type: 'code_ref.published', payload: ref({ branch }) })),
      ).toBe('INVALID_PAYLOAD');
    }
  });

  it('refuses repository URLs that carry credentials', () => {
    const { send, alice } = setup();
    for (const url of ['https://x:ghp_secret@github.com/a/b', 'https://token@github.com/a/b']) {
      expect(
        code(() =>
          send(alice, { type: 'code_ref.published', payload: ref({ repo: { name: 'b', url } }) }),
        ),
      ).toBe('INVALID_PAYLOAD');
    }
    expect(
      code(() =>
        send(alice, {
          type: 'code_ref.published',
          payload: ref({ repo: { name: 'b', url: 'git@github.com:a/b.git' } }),
        }),
      ),
    ).toBe('accepted');
  });

  it('carries no file contents beyond its fields and links only to tasks', () => {
    const { send, alice } = setup();
    const message = send(alice, { type: 'message.created', payload: { text: 'hi' } }).event.id;
    expect(
      code(() => send(alice, { type: 'code_ref.published', payload: ref({ task: message }) })),
    ).toBe('INVALID_REFERENCE');
    expect(
      code(() =>
        send(alice, { type: 'code_ref.published', payload: ref({ summary: 'x'.repeat(5000) }) }),
      ),
    ).toBe('INVALID_PAYLOAD');
  });
});

describe('agent status', () => {
  it('accepts known states about existing items only', () => {
    const { send, alice } = setup();
    const message = send(alice, { type: 'message.created', payload: { text: 'hi' } }).event.id;
    expect(
      code(() =>
        send(alice, {
          type: 'activity.changed',
          payload: { agent: 'claude-code', state: 'working', item: message },
        }),
      ),
    ).toBe('accepted');
    expect(
      code(() =>
        send(alice, {
          type: 'activity.changed',
          payload: { agent: 'claude-code', state: 'working', item: crypto.randomUUID() },
        }),
      ),
    ).toBe('INVALID_REFERENCE');
    expect(
      code(() =>
        send(alice, { type: 'activity.changed', payload: { agent: 'claude-code', state: 'run' } }),
      ),
    ).toBe('INVALID_PAYLOAD');
  });
});
