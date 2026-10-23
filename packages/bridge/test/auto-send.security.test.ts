// Covers: T35 (auto-send of agent drafts), T12 (secret scan still blocks), T38 (two auto modes)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { joinSession, writeRecord } from '@pearcoderhq/client';
import { HostSession, loadOrCreateDeviceIdentity } from '@pearcoderhq/core';
import type { SessionId } from '@pearcoderhq/protocol';
import { type RunningSessionServer, startSessionServer } from '@pearcoderhq/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_SEND_PER_HOUR, startAutoSend } from '../src/auto-send.js';
import { createDraft, getDraft } from '../src/drafts.js';
import { allowItem, approvalOf, declineItem, isAuto, readPolicy, setAuto } from '../src/policy.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pearcoder-auto-'));
  dirs.push(d);
  return d;
};

describe('agent policy', () => {
  it('has "mine" on and "others" off by default, per session', () => {
    const home = temp();
    expect(isAuto(home, 's_a', 'mine')).toBe(true);
    expect(isAuto(home, 's_a', 'others')).toBe(false);
    setAuto(home, 's_a', 'others', true);
    expect(isAuto(home, 's_a', 'others')).toBe(true);
    expect(isAuto(home, 's_b', 'others')).toBe(false);
    setAuto(home, undefined, 'mine', false);
    expect(isAuto(home, 's_b', 'mine')).toBe(false);
    expect(isAuto(home, 's_a', 'mine')).toBe(false);
  });

  it('records approvals, edits and declines per session', () => {
    const home = temp();
    allowItem(home, 's_a', 'e1');
    allowItem(home, 's_a', 'e2', '  Only look at the parser.  ');
    declineItem(home, 's_a', 'e3');
    expect(approvalOf(home, 's_a', 'e1')).toMatchObject({});
    expect(approvalOf(home, 's_a', 'e1')?.text).toBeUndefined();
    expect(approvalOf(home, 's_a', 'e2')?.text).toBe('Only look at the parser.');
    expect(approvalOf(home, 's_a', 'e3')?.declined).toBe(true);
    expect(approvalOf(home, 's_b', 'e1')).toBeUndefined();
  });

  it('falls back to both modes off when the file is damaged', () => {
    const home = temp();
    writeFileSync(join(home, 'agent-policy.json'), JSON.stringify({ v: 2, mine: 'yes' }));
    expect(readPolicy(home)).toMatchObject({ mine: false, others: false });
    writeFileSync(join(home, 'agent-policy.json'), '{not json');
    expect(readPolicy(home)).toMatchObject({ mine: false, others: false });
  });

  it('migrates an ADR-0006 file: per-session auto becomes "others", the global default does not carry over', () => {
    const home = temp();
    writeFileSync(
      join(home, 'agent-policy.json'),
      JSON.stringify({
        v: 1,
        auto: true,
        sessions: { s_a: { auto: true, since: '2026-10-23T10:00:00.000Z' }, s_b: { auto: false } },
        allowed: { s_b: ['e1'] },
      }),
    );
    expect(isAuto(home, 's_a', 'others')).toBe(true);
    expect(isAuto(home, 's_b', 'others')).toBe(false);
    expect(isAuto(home, 's_c', 'others')).toBe(false);
    expect(isAuto(home, 's_c', 'mine')).toBe(true);
    expect(approvalOf(home, 's_b', 'e1')).toBeDefined();
  });
});

describe('auto-send', () => {
  const hostHome = temp();
  const bobHome = temp();
  const host = loadOrCreateDeviceIdentity(hostHome);
  const bob = loadOrCreateDeviceIdentity(bobHome);
  const session = HostSession.create({ identity: host, displayName: 'Hana', sessionName: 'auto' });
  let server: RunningSessionServer;
  const started = new Date(Date.now() - 1000);
  const reply = (text: string) =>
    createDraft(bobHome, {
      sessionId: session.sessionId as SessionId,
      kind: 'reply',
      source: { via: 'mcp', harness: 'claude-code' },
      payload: { text, reply_to: session.log.after(0)[0]?.id ?? '' },
    });

  beforeAll(async () => {
    server = await startSessionServer({ sessions: new Map([[session.sessionId, session]]) });
    const { token } = session.invite({ addresses: [server.url] });
    const joined = await joinSession(token, bob, 'Bob');
    writeRecord(bobHome, { ...joined.host, v: 1, joined_at: new Date().toISOString() });
  });
  afterAll(async () => {
    await server.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('sends agent drafts while auto is on, attributed to the agent', async () => {
    setAuto(bobHome, session.sessionId, 'others', true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const sent: string[] = [];
    const auto = startAutoSend({
      home: bobHome,
      identity: bob,
      startedAt: started,
      onSent: (title) => sent.push(title),
    });
    try {
      const draft = reply('Looks right to me.');
      await auto.tick();
      expect(getDraft(bobHome, draft.id).status).toBe('published');
      const event = session.log.after(0).at(-1);
      expect(event).toMatchObject({ type: 'message.created', actor_user_id: bob.userId });
      expect(event?.actor_agent_id).toMatch(/^a_/);
      expect(sent).toHaveLength(1);
    } finally {
      auto.stop();
    }
  });

  it('never sends with auto off, a draft from before auto, or one that trips the secret scan', async () => {
    const held: string[] = [];
    const auto = startAutoSend({
      home: bobHome,
      identity: bob,
      startedAt: started,
      onHeld: (_title, _session, reason) => held.push(reason),
    });
    try {
      const secret = reply(`token ghp_${'s'.repeat(36)}`);
      await auto.tick();
      expect(getDraft(bobHome, secret.id).status).toBe('draft');
      expect(held).toEqual(['it may contain a secret']);

      setAuto(bobHome, session.sessionId, 'others', false);
      const off = reply('auto is off');
      await auto.tick();
      expect(getDraft(bobHome, off.id).status).toBe('draft');

      // Turning auto back on does not send drafts written while it was off.
      setAuto(bobHome, session.sessionId, 'others', true);
      await auto.tick();
      expect(getDraft(bobHome, off.id).status).toBe('draft');
    } finally {
      auto.stop();
    }
  });

  it(`stops after ${AUTO_SEND_PER_HOUR} sends per session per hour`, async () => {
    const clock = { ms: Date.now() + 1000 };
    const held: string[] = [];
    const auto = startAutoSend({
      home: bobHome,
      identity: bob,
      startedAt: started,
      now: () => clock.ms,
      onHeld: (_title, _session, reason) => held.push(reason),
    });
    try {
      // The previous test switched auto on just now; drafts from that same millisecond don't count.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const drafts = Array.from({ length: AUTO_SEND_PER_HOUR + 1 }, (_, i) => reply(`note ${i}`));
      await auto.tick();
      const statuses = drafts.map((d) => getDraft(bobHome, d.id).status);
      expect(statuses.filter((s) => s === 'published')).toHaveLength(AUTO_SEND_PER_HOUR);
      expect(held).toContain('hourly auto-send limit reached');
    } finally {
      auto.stop();
    }
  });

  it('follows "mine" for answers to the owner\'s own items and never sends a code ref under "others"', async () => {
    const auto = startAutoSend({ home: bobHome, identity: bob, startedAt: started });
    const item = session.log.after(0)[0]?.id ?? '';
    const ref = (byOwner: boolean) =>
      createDraft(bobHome, {
        sessionId: session.sessionId as SessionId,
        kind: 'code_ref',
        source: { via: 'mcp', harness: 'claude-code' },
        trigger: { item, by_owner: byOwner },
        payload: {
          repo: { name: 'app' },
          branch: 'feat/x',
          commit: 'b'.repeat(40),
          summary: 'Add x',
        },
      });
    try {
      // "others" is on from the earlier tests, "mine" is on by default.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const notMine = ref(false);
      await auto.tick();
      expect(getDraft(bobHome, notMine.id).status).toBe('draft');

      setAuto(bobHome, session.sessionId, 'mine', false);
      const mineOff = ref(true);
      await auto.tick();
      expect(getDraft(bobHome, mineOff.id).status).toBe('draft');

      setAuto(bobHome, session.sessionId, 'mine', true);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const mine = ref(true);
      await auto.tick();
      expect(getDraft(bobHome, mine.id).status).toBe('published');
      expect(session.log.after(0).at(-1)).toMatchObject({
        type: 'code_ref.published',
        reply_to: item,
      });
    } finally {
      auto.stop();
    }
  });
});
