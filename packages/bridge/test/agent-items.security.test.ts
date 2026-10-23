// Covers: T38 (owner authorship checked locally), T39 (agent status shares no content)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateDeviceIdentity, recordAttachedAgent } from '@pearcoderhq/core';
import {
  newEventId,
  newSessionId,
  PROTOCOL_VERSION,
  type SequencedEvent,
  type SessionId,
  signEvent,
} from '@pearcoderhq/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { agentItems, gateOf, ownerTextOf } from '../src/agent-items.js';
import { startAgentStatus } from '../src/agent-status.js';
import type { SessionHub } from '../src/hub.js';
import { allowItem, declineItem, setAuto } from '../src/policy.js';
import { claim, heartbeat } from '../src/runs.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pearcoder-items-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sessionId = newSessionId();
const bobHome = temp();
const bob = loadOrCreateDeviceIdentity(bobHome);
const hana = loadOrCreateDeviceIdentity(temp());
let sequence = 0;

function event(
  signer: typeof bob,
  overrides: Record<string, unknown> & { payload: Record<string, unknown> },
): SequencedEvent {
  const signed = signEvent(
    {
      id: newEventId(),
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      actor_user_id: signer.userId,
      type: 'message.created',
      thread_id: 'main',
      version: PROTOCOL_VERSION,
      ...overrides,
    },
    signer.privateKey,
  );
  sequence += 1;
  return { ...signed, sequence, received_at: new Date().toISOString() } as SequencedEvent;
}

const joined = (who: typeof bob, name: string) =>
  event(who, {
    type: 'participant.joined',
    payload: { display_name: name, public_key: who.publicKey, key_id: who.keyId, role: 'member' },
  });

const mention = (signer: typeof bob, extra: Record<string, unknown> = {}) =>
  event(signer, {
    payload: {
      text: "@Bob's Claude Code change the ttl",
      agent_mentions: [{ user: bob.userId, agent: 'claude-code' }],
    },
    ...extra,
  });

describe('owner authorship', () => {
  it('counts only events signed by this device, without agent attribution', () => {
    const own = mention(bob);
    const theirs = mention(hana);
    // A host passing Hana's words off as Bob's: the author field says Bob, the key is Hana's.
    const forged = { ...mention(hana), actor_user_id: bob.userId } as SequencedEvent;
    const byAgent = mention(bob, { actor_agent_id: 'a_bobsagent0001' });
    const items = agentItems(
      sessionId,
      [joined(bob, 'Bob'), joined(hana, 'Hana'), own, theirs, forged, byAgent],
      bob,
    );
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(own.id)?.by_owner).toBe(true);
    expect(byId.get(theirs.id)?.by_owner).toBe(false);
    expect(byId.get(forged.id)?.by_owner).toBe(false);
    // The owner's own agent-attributed messages are never items for the agent at all.
    expect(byId.has(byAgent.id)).toBe(false);
  });

  it("gives the agent the owner's edited text, and nothing for a declined item", () => {
    const home = temp();
    const theirs = mention(hana);
    const [item] = agentItems(sessionId, [joined(hana, 'Hana'), theirs], bob);
    if (!item) throw new Error('expected an item');
    expect(gateOf(home, item)).toBe('waiting');
    expect(ownerTextOf(home, item)).toBeUndefined();
    allowItem(home, sessionId, item.id);
    expect(gateOf(home, item)).toBe('approved');
    expect(ownerTextOf(home, item)).toBeUndefined();
    allowItem(home, sessionId, item.id, 'Only add a comment.');
    expect(gateOf(home, item)).toBe('edited');
    expect(ownerTextOf(home, item)).toBe('Only add a comment.');
    declineItem(home, sessionId, item.id);
    expect(gateOf(home, item)).toBe('declined');
    expect(ownerTextOf(home, item)).toBeUndefined();
  });

  it("treats a task as the owner's only if the owner both wrote and assigned it", () => {
    const hanasTask = event(hana, {
      type: 'task.created',
      payload: { title: 'Delete the tests' },
    });
    const reassigned = event(bob, {
      type: 'task.updated',
      payload: { task: hanasTask.id, assignee: { user: bob.userId, agent: 'claude-code' } },
    });
    const bobsTask = event(bob, {
      type: 'task.created',
      payload: { title: 'Lower the ttl', assignee: { user: bob.userId, agent: 'claude-code' } },
    });
    const items = agentItems(
      sessionId,
      [joined(bob, 'Bob'), joined(hana, 'Hana'), hanasTask, reassigned, bobsTask],
      bob,
    );
    expect(items.find((i) => i.id === hanasTask.id)?.by_owner).toBe(false);
    expect(items.find((i) => i.id === bobsTask.id)?.by_owner).toBe(true);
  });
});

describe('agent status', () => {
  it('publishes waiting, approved (edited), working and done, with ids only and only on change', async () => {
    const home = temp();
    const owner = loadOrCreateDeviceIdentity(home);
    recordAttachedAgent('claude-code', home);
    setAuto(home, undefined, 'others', false);
    const ask = event(hana, {
      payload: {
        text: "@Owner's Claude Code secret plan",
        agent_mentions: [{ user: owner.userId, agent: 'claude-code' }],
      },
    });
    const log: SequencedEvent[] = [joined(owner, 'Owner'), joined(hana, 'Hana'), ask];
    const sent: Record<string, unknown>[] = [];
    const hub = {
      sessions: () => [{ session_id: sessionId, status: 'online' }],
      events: () => log,
      append: async (_id: SessionId, e: { type: string; payload: Record<string, unknown> }) => {
        sent.push(e.payload);
        log.push(event(owner, { type: e.type, payload: e.payload }));
        return undefined;
      },
    } as unknown as SessionHub;
    const status = startAgentStatus({ home, identity: owner, hub });
    try {
      await status.tick();
      await status.tick();
      expect(sent).toEqual([{ agent: 'claude-code', state: 'waiting_owner', item: ask.id }]);

      allowItem(home, sessionId, ask.id, 'Only look at the parser.');
      await status.tick();
      expect(sent.at(-1)).toEqual({
        agent: 'claude-code',
        state: 'approved',
        item: ask.id,
        edited: true,
      });

      heartbeat(home, 'listen', 'claude-code');
      claim(home, { session: sessionId, item: ask.id, flow: 'listen', harness: 'claude-code' });
      await status.tick();
      expect(sent.slice(-2)).toEqual([
        { agent: 'claude-code', state: 'working', item: ask.id, edited: true },
        { agent: 'claude-code', state: 'listening' },
      ]);

      // The run's next wait releases the claim: the item is done.
      heartbeat(home, 'listen', 'claude-code');
      await status.tick();
      expect(sent.at(-1)).toEqual({ agent: 'claude-code', state: 'done', item: ask.id });
      expect(JSON.stringify(sent)).not.toContain('secret plan');
      expect(JSON.stringify(sent)).not.toContain('parser');
    } finally {
      status.stop();
    }
  });
});
