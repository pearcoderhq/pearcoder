import { describe, expect, it } from 'vitest';
import type { WireEvent } from './api';
import {
  isOnline,
  looksLikeAgentTask,
  mentionedAgent,
  openMentionsFor,
  participants,
  presenceLabel,
} from './model';

let sequence = 0;
const event = (actor: string, type: string, payload: Record<string, unknown> = {}): WireEvent => {
  sequence += 1;
  return {
    id: `e${sequence}`,
    sequence,
    type,
    actor_user_id: actor,
    received_at: '2026-10-23T10:00:00.000Z',
    thread_id: 'main',
    payload,
  };
};
const joined = (actor: string, name: string) =>
  event(actor, 'participant.joined', { display_name: name, role: 'member' });

describe('attached agents', () => {
  it('come from the latest presence announcement', () => {
    const log = [
      joined('u1', 'Hana'),
      event('u1', 'presence.changed', { state: 'online', agents: ['claude-code', 42] }),
    ];
    expect(participants(log)[0]?.agents).toEqual(['claude-code']);
    log.push(event('u1', 'presence.changed', { state: 'online', agents: [] }));
    expect(participants(log)[0]?.agents).toEqual([]);
  });
});

describe('presence', () => {
  it('treats joined as not yet online, until the person announces it', () => {
    const log = [joined('u1', 'Hana'), joined('u2', 'Alice')];
    const [hana, alice] = participants(log);
    expect(hana && isOnline(hana)).toBe(false);
    expect(alice && presenceLabel(alice)).toBe('joined, not seen online yet');

    log.push(event('u2', 'presence.changed', { state: 'online' }));
    expect(
      participants(log)
        .filter(isOnline)
        .map((p) => p.name),
    ).toEqual(['Alice']);
    log.push(event('u2', 'presence.changed', { state: 'offline' }));
    expect(participants(log).filter(isOnline)).toEqual([]);
  });

  it("uses this device's live connection for its own entry", () => {
    const log = [
      joined('u1', 'Hana'),
      event('u1', 'presence.changed', { state: 'online' }),
      joined('u2', 'Alice'),
    ];
    // Hana's connection dropped; her last announcement still says online.
    expect(participants(log, { userId: 'u1', online: false }).filter(isOnline)).toEqual([]);
    expect(participants(log, { userId: 'u2', online: true }).filter(isOnline)).toHaveLength(2);
    log.push(event('u2', 'participant.left'));
    expect(participants(log, { userId: 'u2', online: true }).map(presenceLabel)).toEqual([
      'online',
      'left',
    ]);
  });
});

describe('mentions', () => {
  it('lists messages that mention me or my agent until I reply', () => {
    const log = [
      joined('u1', 'Hana'),
      joined('u2', 'Alice'),
      event('u2', 'message.created', { text: '@Hana hi', mentions: ['u1'] }),
      event('u2', 'message.created', {
        text: "@Hana's Claude Code check",
        agent_mentions: [{ user: 'u1', agent: 'claude-code' }],
      }),
      event('u1', 'message.created', { text: '@Alice me', mentions: ['u2'] }),
    ];
    const open = openMentionsFor(log, 'u1');
    expect(open.map((e) => e.payload.text)).toEqual(['@Hana hi', "@Hana's Claude Code check"]);
    expect(open[1] && mentionedAgent(open[1], 'u1')).toBe('claude-code');
    log.push({ ...event('u1', 'message.created', { text: 'thanks' }), reply_to: open[0]?.id });
    expect(openMentionsFor(log, 'u1')).toHaveLength(1);
  });
});

describe('unaddressed task hint', () => {
  const candidates = [
    { label: 'Hana', user: 'u1' },
    { label: "Hana's Claude Code", user: 'u1', agent: 'claude-code' as const },
  ];

  it('flags a request for work that mentions nobody', () => {
    expect(looksLikeAgentTask('Fix the retry on 503', candidates)).toBe(true);
    expect(looksLikeAgentTask('can you rename token.ts?', candidates)).toBe(true);
    expect(looksLikeAgentTask('please look at the flaky test', candidates)).toBe(true);
  });

  it('stays quiet once someone is mentioned, or for plain chat', () => {
    expect(looksLikeAgentTask("@Hana's Claude Code fix the retry on 503", candidates)).toBe(false);
    expect(looksLikeAgentTask('@Hana fix the retry on 503', candidates)).toBe(false);
    expect(looksLikeAgentTask('lunch at 12?', candidates)).toBe(false);
    expect(looksLikeAgentTask('fixed it', candidates)).toBe(false);
    expect(looksLikeAgentTask('fix', candidates)).toBe(false);
  });
});
