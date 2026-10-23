import { z } from 'zod';
import {
  AgentIdSchema,
  EventIdSchema,
  KeyIdSchema,
  SessionIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from './ids.js';

// Bumped on breaking changes to the event envelope or event payloads (docs/invariants.md, engineering rules).
export const PROTOCOL_VERSION = 1;

// Canonical JSON of a signed event may not exceed this, except for the types listed below.
export const MAX_EVENT_BYTES = 64 * 1024;

/** Larger limits for event types that carry documents (context packages, D7). */
export const MAX_EVENT_BYTES_BY_TYPE: Readonly<Record<string, number>> = {
  'context_package.published': 256 * 1024,
};

/** The largest any single event may be; transports size their limits from this. */
export const MAX_ANY_EVENT_BYTES = 256 * 1024;

export function maxEventBytes(type: string): number {
  return MAX_EVENT_BYTES_BY_TYPE[type] ?? MAX_EVENT_BYTES;
}

export const EventTypeSchema = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

// Loose objects keep unknown fields so newer clients' additions survive older hosts, and those
// fields stay covered by the author's signature.
export const UnsignedEventSchema = z.looseObject({
  id: EventIdSchema,
  session_id: SessionIdSchema,
  timestamp: z.iso.datetime(),
  actor_user_id: UserIdSchema,
  // Attribution only: the owner's device signs events drafted by their agent (ADR-0003).
  actor_agent_id: AgentIdSchema.optional(),
  type: EventTypeSchema,
  thread_id: ThreadIdSchema,
  reply_to: EventIdSchema.optional(),
  version: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
});

export const SignatureSchema = z.object({
  alg: z.literal('ed25519'),
  key_id: KeyIdSchema,
  value: z.base64url(),
});

export const SignedEventSchema = UnsignedEventSchema.extend({ sig: SignatureSchema });

// Host-assigned fields. They are not covered by the author's signature: the host orders events
// but cannot alter what the author signed (threat model T09).
export const ChainLinkSchema = z.object({
  prev: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  sig: z.base64url(),
});

export const SequencedEventSchema = SignedEventSchema.extend({
  sequence: z.number().int().positive(),
  received_at: z.iso.datetime(),
  /** Host seal linking this event to the previous one (protocol/chain.ts). */
  chain: ChainLinkSchema.optional(),
});

export type UnsignedEvent = z.infer<typeof UnsignedEventSchema>;
export type Signature = z.infer<typeof SignatureSchema>;
export type SignedEvent = z.infer<typeof SignedEventSchema>;
export type SequencedEvent = z.infer<typeof SequencedEventSchema>;

const HOST_FIELDS = new Set(['sig', 'sequence', 'received_at', 'chain']);

// The exact object an author signs: every field except the signature and host-assigned ones.
export function signingPayload(event: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(event).filter(([key]) => !HOST_FIELDS.has(key)));
}
