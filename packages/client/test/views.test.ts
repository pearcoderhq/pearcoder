import type { SequencedEvent } from '@pearcoderhq/protocol';
import { describe, expect, it } from 'vitest';
import { mentionsOf } from '../src/views.js';

let sequence = 0;
const message = (
  actor: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  ({
    id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    sequence,
    type: 'message.created',
    actor_user_id: actor,
    received_at: '2026-10-23T10:00:00.000Z',
    payload,
    ...extra,
  }) as unknown as SequencedEvent;

describe('mentionsOf', () => {
  it("includes the owner asking their own agent, but not the owner's own @mentions of themselves", () => {
    const events = [
      message('u_me', {
        text: "@me's Claude Code hey",
        agent_mentions: [{ user: 'u_me', agent: 'claude-code' }],
      }),
      message('u_me', { text: '@me note to self', mentions: ['u_me'] }),
      message('u_alice', { text: '@me look', mentions: ['u_me'] }),
    ];
    expect(mentionsOf(events, 'u_me').map((m) => [m.text, m.agent ?? null])).toEqual([
      ["@me's Claude Code hey", 'claude-code'],
      ['@me look', null],
    ]);
  });

  it("never returns the owner's agent's own messages, and drops answered ones", () => {
    const ask = message('u_me', {
      text: "@me's Claude Code check",
      agent_mentions: [{ user: 'u_me', agent: 'claude-code' }],
    });
    const byAgent = message(
      'u_me',
      { text: "@me's Claude Code again", agent_mentions: [{ user: 'u_me', agent: 'claude-code' }] },
      { actor_agent_id: 'a_myagent0001' },
    );
    expect(mentionsOf([ask, byAgent], 'u_me').map((m) => m.id)).toEqual([ask.id]);
    const answer = message(
      'u_me',
      { text: 'done' },
      { reply_to: ask.id, actor_agent_id: 'a_myagent0001' },
    );
    expect(mentionsOf([ask, byAgent, answer], 'u_me')).toEqual([]);
  });
});
