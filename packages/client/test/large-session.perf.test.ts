// Covers: T07 (large sessions stay usable: a 10k-event replay budget)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostSession, loadOrCreateDeviceIdentity, openSessionStore } from '@pearcoderhq/core';
import { newEventId, newSessionId, PROTOCOL_VERSION, signEvent } from '@pearcoderhq/protocol';
import { startSessionServer } from '@pearcoderhq/server';
import { afterAll, describe, expect, it } from 'vitest';
import { joinSession, SessionClient } from '../src/client.js';
import { MemoryCursorStore } from '../src/cursor.js';
import { renderJsonl, verifyExport } from '../src/export.js';

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Budgets are generous for slow CI runners; locally each step takes a fraction of this.
// They exist to catch accidental quadratic work, not to benchmark.
// Persisted appends fsync every event (synchronous = full). On Windows CI runners that costs 7 to
// 20 ms per event, against well under 1 ms on macOS and Linux, so Windows runs a smaller session.
// Either way it is far above the per-person rate limit of 2 events a second.
const EVENTS = process.platform === 'win32' ? 2_000 : 10_000;
const BUDGET_MS = { append: 60_000, replay: 15_000, verify: 15_000 };

describe('a 10k-event session', () => {
  it('appends, persists, replays over HTTP and verifies within budget', async () => {
    const home = temp('pearcoder-perf-host-');
    const host = loadOrCreateDeviceIdentity(home);
    const sessionId = newSessionId();
    const store = openSessionStore(home, sessionId);
    const session = HostSession.create({
      identity: host,
      displayName: 'Hana',
      sessionName: 'big',
      sessionId,
      store,
      rateLimit: { burst: EVENTS * 2, perSecond: EVENTS },
    });

    let started = performance.now();
    for (let i = 0; i < EVENTS; i += 1) {
      session.log.append(
        signEvent(
          {
            id: newEventId(),
            session_id: sessionId,
            timestamp: new Date().toISOString(),
            actor_user_id: host.userId,
            type: 'message.created',
            thread_id: 'main',
            version: PROTOCOL_VERSION,
            payload: { text: `message ${i} ${'x'.repeat(200)}` },
          },
          host.privateKey,
        ),
      );
    }
    const append = performance.now() - started;
    expect(session.log.head).toBe(EVENTS + 1);

    const server = await startSessionServer({ sessions: new Map([[sessionId, session]]) });
    try {
      const alice = loadOrCreateDeviceIdentity(temp('pearcoder-perf-alice-'));
      const { token } = session.invite({ addresses: [server.url] });
      const joined = await joinSession(token, alice, 'Alice');
      const client = new SessionClient({
        host: joined.host,
        endpoint: joined.endpoint,
        identity: alice,
        cursors: new MemoryCursorStore(),
      });
      started = performance.now();
      const history = await client.history();
      const replay = performance.now() - started;
      expect(history).toHaveLength(EVENTS + 2);

      started = performance.now();
      const report = verifyExport(renderJsonl(history));
      const verify = performance.now() - started;
      expect(report).toMatchObject({ ok: true, sealed: true });

      console.log(
        `${EVENTS} events: append ${append.toFixed(0)} ms, replay ${replay.toFixed(0)} ms, verify ${verify.toFixed(0)} ms`,
      );
      expect(append).toBeLessThan(BUDGET_MS.append);
      expect(replay).toBeLessThan(BUDGET_MS.replay);
      expect(verify).toBeLessThan(BUDGET_MS.verify);
    } finally {
      await server.close();
      store.close();
    }
  }, 240_000);
});
