// Covers: T35 (auto-send of agent drafts), T12 (secret scan still blocks)
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
import { allowItem, isAllowed, isAuto, readPolicy, setAuto } from '../src/policy.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pearcoder-auto-'));
  dirs.push(d);
  return d;
};

describe('agent policy', () => {
  it('is on by default, per session, and falls back to off when the file is damaged', () => {
    const home = temp();
    expect(isAuto(home, 's_a')).toBe(true);
    setAuto(home, 's_a', false);
    expect(isAuto(home, 's_a')).toBe(false);
    expect(isAuto(home, 's_b')).toBe(true);
    setAuto(home, undefined, false);
    expect(isAuto(home, 's_b')).toBe(false);
    allowItem(home, 's_a', 'e1');
    expect(isAllowed(home, 's_a', 'e1')).toBe(true);
    expect(isAllowed(home, 's_b', 'e1')).toBe(false);

    writeFileSync(join(home, 'agent-policy.json'), JSON.stringify({ v: 1, auto: 'yes' }));
    expect(readPolicy(home).auto).toBe(false);
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

      setAuto(bobHome, session.sessionId, false);
      const off = reply('auto is off');
      await auto.tick();
      expect(getDraft(bobHome, off.id).status).toBe('draft');

      // Turning auto back on does not send drafts written while it was off.
      setAuto(bobHome, session.sessionId, true);
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
});
