// Covers: T09 (exports are verifiable), T12 (participant text cannot restructure the export)

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostSession, loadOrCreateDeviceIdentity } from '@pearcoderhq/core';
import {
  newSessionId,
  type SequencedEvent,
  signEvent,
  signProof,
  type UnsignedEvent,
} from '@pearcoderhq/protocol';
import { type TestKey, testEvent, testJoinEvent, testKey } from '@pearcoderhq/protocol/testing';
import { describe, expect, it } from 'vitest';
import { renderJsonl, renderReviewMarkdown, verifyExport } from '../src/export.js';

function scenario() {
  const sessionId = newSessionId();
  const keys = { hana: testKey(), alice: testKey() };
  const events: SequencedEvent[] = [];
  let seq = 0;
  const push = (signed: ReturnType<typeof signEvent>) => {
    seq += 1;
    events.push({
      ...signed,
      sequence: seq,
      received_at: `2026-10-23T10:00:${String(seq).padStart(2, '0')}.000Z`,
    });
    return signed.id;
  };
  const say = (key: TestKey, overrides: Partial<UnsignedEvent>) =>
    push(signEvent(testEvent(key.userId, { session_id: sessionId, ...overrides }), key.privateKey));
  push(testJoinEvent(keys.hana, sessionId, 'host', 'Hana'));
  push(testJoinEvent(keys.alice, sessionId, 'member', 'Alice'));
  const req = say(keys.hana, {
    type: 'request.created',
    payload: { to: [keys.alice.userId], kind: 'review', title: 'Review rotation' },
  });
  const high = say(keys.alice, {
    type: 'review.finding',
    actor_agent_id: 'a_claudecode0001',
    payload: {
      title: 'Race in rotate()',
      severity: 'high',
      body: 'check-then-act\n# not a heading',
      request: req,
      location: { path: 'src/token.ts', start_line: 3, end_line: 9 },
    },
  });
  say(keys.alice, {
    type: 'review.finding',
    payload: { title: 'Typo', severity: 'low', body: 'nit' },
  });
  say(keys.hana, { type: 'message.created', reply_to: high, payload: { text: 'Agreed, fixing.' } });
  say(keys.hana, {
    type: 'finding.resolved',
    payload: { finding: high, resolution: 'fixed', note: 'CAS update' },
  });
  const d = say(keys.hana, {
    type: 'decision.proposed',
    payload: {
      title: 'Use CAS for rotation',
      decision: 'Conditional UPDATE',
      alternatives: ['Serializable tx'],
    },
  });
  say(keys.alice, { type: 'decision.vote', payload: { decision: d, stance: 'agree' } });
  say(keys.hana, { type: 'decision.resolved', payload: { decision: d, outcome: 'accepted' } });
  return { events };
}

describe('review export', () => {
  it('renders findings by severity with status, replies, decisions and action items', () => {
    const md = renderReviewMarkdown(scenario().events, { sessionName: 'auth-review' });
    expect(md).toContain('# Review: auth-review');
    expect(md.indexOf('[HIGH] Race in rotate()')).toBeLessThan(md.indexOf('[LOW] Typo'));
    expect(md).toContain("Alice's agent · `src/token.ts:3-9` · **fixed (Hana)**");
    expect(md).toContain('- Hana: Agreed, fixing.');
    expect(md).toContain('### Use CAS for rotation (accepted by Hana)');
    expect(md).toContain('**Stances.** Alice: agree');
    expect(md).toContain('- [ ] Resolve [low] Typo');
    expect(md).toContain('- [ ] Implement: Use CAS for rotation');
    expect(md).toContain('Reviewed with [Pearcoder]');
    // Participant text is quoted, so it cannot add headings to the document.
    expect(md).toContain('> # not a heading');
    expect(
      renderReviewMarkdown(scenario().events, { sessionName: 'x', footer: false }),
    ).not.toContain('Reviewed with');
  });

  it('verifies an exported log and detects tampering, gaps and forged authors', () => {
    const { events } = scenario();
    const good = renderJsonl(events);
    expect(verifyExport(good)).toEqual({
      ok: true,
      events: events.length,
      sealed: false,
      problems: [],
    });

    const tampered = good.replace('Agreed, fixing.', 'Rejected, not fixing.');
    expect(verifyExport(tampered).problems).toEqual([
      expect.stringContaining('signature does not verify'),
    ]);

    const gap = renderJsonl(events.filter((_, i) => i !== 3));
    expect(verifyExport(gap).ok).toBe(false);

    const stranger = testKey();
    const forged = {
      ...signEvent(
        testEvent(stranger.userId, { session_id: events[0]?.session_id }),
        stranger.privateKey,
      ),
      sequence: events.length + 1,
      received_at: '2026-10-23T11:00:00.000Z',
    };
    expect(verifyExport(good + JSON.stringify(forged)).problems).toEqual([
      expect.stringContaining('author never joined'),
    ]);
  });
});

describe('host-sealed history (T09)', () => {
  const sealedLog = () => {
    const host = loadOrCreateDeviceIdentity(mkdtempSync(join(tmpdir(), 'pearcoder-seal-')));
    const session = HostSession.create({
      identity: host,
      displayName: 'Hana',
      sessionName: 'seal',
    });
    for (const text of ['one', 'two', 'three']) {
      session.log.append(
        signEvent(
          testEvent(host.userId, { session_id: session.sessionId, payload: { text } }),
          host.privateKey,
        ),
      );
    }
    return session.log.after(0).map((e) => JSON.parse(JSON.stringify(e)));
  };
  const jsonl = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

  it('verifies a sealed log, and a log cut short at the end as a prefix', () => {
    const events = sealedLog();
    expect(verifyExport(jsonl(events))).toEqual({
      ok: true,
      events: 4,
      sealed: true,
      problems: [],
    });
    expect(verifyExport(jsonl(events.slice(0, 2)))).toMatchObject({ ok: true, sealed: true });
  });

  it('detects a removed event even when later sequences are renumbered', () => {
    const events = sealedLog();
    const cut = [events[0], events[1], ...events.slice(3)].map((e, i) => ({
      ...e,
      sequence: i + 1,
    }));
    const report = verifyExport(jsonl(cut));
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toMatch(/chain/);
  });

  it('detects a re-timed event and a stripped seal', () => {
    const events = sealedLog();
    const retimed = events.map((e, i) =>
      i === 2 ? { ...e, received_at: '2020-01-01T00:00:00.000Z' } : e,
    );
    expect(verifyExport(jsonl(retimed)).problems).toContain(
      'line 3: chain hash mismatch (sequence or time was changed)',
    );
    const stripped = events.map((e, i) => (i === 2 ? { ...e, chain: undefined } : e));
    expect(verifyExport(jsonl(stripped)).problems).toContain(
      'line 3: missing host seal in a sealed log',
    );
  });

  it('refuses a log whose seals were stripped, and files that are not logs', () => {
    const events = sealedLog();
    // Strip every seal and drop an event: without the host's signed promise this would pass as
    // an export from an older host.
    const stripped = events
      .filter((_, i) => i !== 2)
      .map((e, i) => ({ ...e, chain: undefined, sequence: i + 1 }));
    expect(verifyExport(jsonl(stripped)).problems).toEqual([
      'host seals were removed: the host signed that it seals every event',
    ]);
    expect(verifyExport('')).toMatchObject({
      ok: false,
      problems: ['no events: the file is empty'],
    });
    expect(verifyExport('# Review\n\nsome markdown\n- a\n- b\n').problems).toEqual([
      'not a Pearcoder log: export one with `pearcoder export --format jsonl`',
    ]);
  });

  it('rejects a chain resealed by someone other than the host', () => {
    const events = sealedLog();
    const forger = testKey();
    const forged = events.map((e) => ({
      ...e,
      chain: { ...e.chain, sig: signProof(Buffer.from(e.chain.hash, 'utf8'), forger.privateKey) },
    }));
    expect(verifyExport(jsonl(forged)).problems[0]).toBe('line 1: host seal does not verify');
  });
});
