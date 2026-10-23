import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import { SequencedEventSchema, SignedEventSchema, UnsignedEventSchema } from './envelope.js';
import { checkPayload, PresenceChangedSchema, RequestCreatedSchema } from './events.js';
import { protocolJsonSchemas } from './json-schema.js';
import { findMentions, mentionCandidates } from './mentions.js';
import { signEvent } from './signing.js';
import { testEvent, testKey } from './testing.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 'é' })).toBe(canonicalJson({ y: 'é', x: 1 }));
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
  });
});

describe('envelope', () => {
  const key = testKey();

  it('round-trips a signed event through JSON', () => {
    const signed = signEvent(testEvent(key.userId), key.privateKey);
    const parsed = SignedEventSchema.parse(JSON.parse(JSON.stringify(signed)));
    expect(parsed).toEqual(signed);
  });

  it('preserves unknown envelope and payload fields (forward compatibility)', () => {
    const event = {
      ...testEvent(key.userId, { payload: { text: 'hi', future_flag: true } }),
      future_field: { nested: 1 },
    };
    const parsed = UnsignedEventSchema.parse(event);
    expect(parsed).toMatchObject({ future_field: { nested: 1 }, payload: { future_flag: true } });
  });

  it('requires host fields on sequenced events', () => {
    const signed = signEvent(testEvent(key.userId), key.privateKey);
    expect(SequencedEventSchema.safeParse(signed).success).toBe(false);
    expect(
      SequencedEventSchema.safeParse({
        ...signed,
        sequence: 1,
        received_at: '2026-10-22T10:00:01.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects malformed ids and types', () => {
    expect(UnsignedEventSchema.safeParse(testEvent(key.userId, { type: 'Message' })).success).toBe(
      false,
    );
    expect(
      UnsignedEventSchema.safeParse({ ...testEvent(key.userId), actor_user_id: 'u_short' }).success,
    ).toBe(false);
  });
});

describe('payloads', () => {
  it('validates known event types and leaves unknown types alone', () => {
    expect(checkPayload({ type: 'message.created', payload: { text: 'hi' } })).toEqual({
      known: true,
      ok: true,
    });
    expect(checkPayload({ type: 'message.created', payload: { text: '' } })).toMatchObject({
      known: true,
      ok: false,
    });
    expect(checkPayload({ type: 'future.thing', payload: { anything: 1 } })).toEqual({
      known: false,
    });
  });
});

describe('protocolJsonSchemas', () => {
  it('exports JSON Schema for envelopes and every payload', () => {
    const schemas = protocolJsonSchemas();
    expect(schemas.SignedEvent).toMatchObject({ type: 'object' });
    expect(Object.keys(schemas.payloads as object)).toContain('message.created');
  });
});

describe('agent fields', () => {
  it('accepts known harnesses on presence and requests, and rejects others', () => {
    expect(
      PresenceChangedSchema.safeParse({ state: 'online', agents: ['claude-code'] }).success,
    ).toBe(true);
    expect(PresenceChangedSchema.safeParse({ state: 'online', agents: ['skynet'] }).success).toBe(
      false,
    );
    const request = { to: [testKey().userId], kind: 'review', title: 'Look' };
    expect(RequestCreatedSchema.safeParse({ ...request, for_agent: 'codex' }).success).toBe(true);
    expect(RequestCreatedSchema.safeParse({ ...request, for_agent: 'bash' }).success).toBe(false);
  });
});

describe('findMentions', () => {
  const candidates = mentionCandidates([
    { user: 'u_alice', name: 'Alice', agents: ['claude-code'] },
    { user: 'u_bob', name: 'Bob Smith' },
  ]);

  it('finds people and agents, preferring the longer label', () => {
    expect(findMentions("@Alice's Claude Code can you check? cc @bob smith", candidates)).toEqual({
      mentions: ['u_bob'],
      agent_mentions: [{ user: 'u_alice', agent: 'claude-code' }],
    });
    expect(findMentions('@Alice, thoughts?', candidates).mentions).toEqual(['u_alice']);
  });

  it('needs a word boundary and ignores unknown names and email addresses', () => {
    expect(findMentions('@Alicea @nobody mail me at x@Alice.dev', candidates)).toEqual({
      mentions: [],
      agent_mentions: [],
    });
  });
});
