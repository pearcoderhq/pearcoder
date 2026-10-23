import { z } from 'zod';
import { contextPackageHash } from './context-package.js';
import type { SignedEvent } from './envelope.js';
import { EventIdSchema, KeyIdSchema, UserIdSchema } from './ids.js';

export const RoleSchema = z.enum(['host', 'member', 'observer']);
export type Role = z.infer<typeof RoleSchema>;

// Lifecycle states from the design doc §10. Ephemeral: hosts may drop old presence events.
export const PresenceStateSchema = z.enum([
  'online',
  'bridge_connected',
  'agent_available',
  'agent_busy',
  'awaiting_owner',
  'offline',
]);

export const ParticipantJoinedSchema = z.looseObject({
  display_name: z.string().trim().min(1).max(80),
  public_key: z.base64url(),
  key_id: KeyIdSchema,
  role: RoleSchema,
  /** Host joins only: the host seals every event with this chain version (docs/protocol.md). */
  seals: z.literal('chain-v1').optional(),
});

export const ParticipantLeftSchema = z.looseObject({
  reason: z.string().max(200).optional(),
});

/** Agent harnesses a person can attach to Pearcoder through MCP (`pearcoder attach`). */
export const AgentHarnessSchema = z.enum(['claude-code', 'codex']);
export type AgentHarness = z.infer<typeof AgentHarnessSchema>;

export const MessageCreatedSchema = z.looseObject({
  text: z.string().min(1).max(16_000),
  /** People mentioned with `@Name`. */
  mentions: z.array(UserIdSchema).max(50).optional(),
  /**
   * Agents mentioned with `@Name's Claude Code`. Like a request, this only reaches the owner's
   * inbox; the owner decides whether their agent answers.
   */
  agent_mentions: z
    .array(z.object({ user: UserIdSchema, agent: AgentHarnessSchema }))
    .max(20)
    .optional(),
});

export const PresenceChangedSchema = z.looseObject({
  state: PresenceStateSchema,
  /**
   * The agents this person has attached, so others can address a request to them. It says
   * nothing about what an agent is doing, and nobody but the owner can start one.
   */
  agents: z.array(AgentHarnessSchema).max(4).optional(),
});

// A request asks people to consider something. It is information for humans and never an
// instruction to anyone's agent (docs/invariants.md, invariant 1).
export const RequestCreatedSchema = z.looseObject({
  to: z.array(UserIdSchema).min(1).max(20),
  kind: z.enum(['review', 'question', 'discussion']),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(16_000).optional(),
  /** Event id of the `context_package.published` this request is about. */
  context_package: EventIdSchema.optional(),
  /**
   * The requester would like the addressees to use this agent of theirs. Informational only:
   * it shows in their inbox, and they decide whether and how to run it.
   */
  for_agent: AgentHarnessSchema.optional(),
});

export const RequestResolvedSchema = z.looseObject({
  request: EventIdSchema,
  resolution: z.enum(['accepted', 'declined', 'done']),
  note: z.string().max(2_000).optional(),
});

const Sha256Schema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const ContextPackageSchema = z.looseObject({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(4_000),
  constraints: z.array(z.string().max(1_000)).max(50).default([]),
  repo: z
    .looseObject({
      name: z.string().max(200),
      url: z.string().max(500).optional(),
      base: Sha256Schema.optional(),
      head: Sha256Schema.optional(),
    })
    .optional(),
  paths: z.array(z.string().max(500)).max(200).default([]),
  excerpts: z
    .array(
      z.looseObject({
        path: z.string().max(500),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
        text: z.string().max(64_000),
      }),
    )
    .max(50)
    .default([]),
  body: z.string().max(200_000).default(''),
  /** Number of this package's versions; a new version is a new event with `previous`. */
  version: z.number().int().positive().default(1),
  previous: EventIdSchema.optional(),
  /** `sha256:` of the canonical package without this field; lets anyone check integrity. */
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const ReviewFindingSchema = z.looseObject({
  title: z.string().trim().min(1).max(200),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  body: z.string().min(1).max(16_000),
  request: EventIdSchema.optional(),
  context_package: EventIdSchema.optional(),
  location: z
    .looseObject({
      path: z.string().max(500),
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional(),
      commit: Sha256Schema.optional(),
    })
    .optional(),
});

export const FindingResolvedSchema = z.looseObject({
  finding: EventIdSchema,
  resolution: z.enum(['fixed', 'accepted_risk', 'wont_fix', 'invalid']),
  note: z.string().max(4_000).optional(),
});

// Decisions are what a session is for: a proposal, people's stances, and an outcome recorded by
// the proposer or host. They describe what the team agreed; they never trigger anything.
export const DecisionProposedSchema = z.looseObject({
  title: z.string().trim().min(1).max(200),
  decision: z.string().trim().min(1).max(8_000),
  rationale: z.string().max(8_000).optional(),
  alternatives: z.array(z.string().max(2_000)).max(20).optional(),
  /** Findings, requests, packages or messages this decision is based on. */
  related: z.array(EventIdSchema).max(50).optional(),
});

export const DecisionVoteSchema = z.looseObject({
  decision: EventIdSchema,
  stance: z.enum(['agree', 'disagree', 'abstain']),
  note: z.string().max(4_000).optional(),
});

export const DecisionResolvedSchema = z.looseObject({
  decision: EventIdSchema,
  outcome: z.enum(['accepted', 'rejected', 'superseded']),
  note: z.string().max(4_000).optional(),
});

export const EVENT_PAYLOAD_SCHEMAS = {
  'participant.joined': ParticipantJoinedSchema,
  'participant.left': ParticipantLeftSchema,
  'message.created': MessageCreatedSchema,
  'presence.changed': PresenceChangedSchema,
  'request.created': RequestCreatedSchema,
  'request.resolved': RequestResolvedSchema,
  'context_package.published': ContextPackageSchema,
  'review.finding': ReviewFindingSchema,
  'finding.resolved': FindingResolvedSchema,
  'decision.proposed': DecisionProposedSchema,
  'decision.vote': DecisionVoteSchema,
  'decision.resolved': DecisionResolvedSchema,
} as const;

export type KnownEventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;
export type EventPayload<T extends KnownEventType> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;

export function isKnownEventType(type: string): type is KnownEventType {
  return Object.hasOwn(EVENT_PAYLOAD_SCHEMAS, type);
}

export type PayloadCheck =
  | { known: true; ok: true }
  | { known: true; ok: false; issues: string[] }
  | { known: false };

// Unknown event types are kept and relayed but never interpreted (forward compatibility).
export function checkPayload(event: Pick<SignedEvent, 'type' | 'payload'>): PayloadCheck {
  if (!isKnownEventType(event.type)) return { known: false };
  const result = EVENT_PAYLOAD_SCHEMAS[event.type].safeParse(event.payload);
  if (result.success) {
    // The hash covers the payload as sent, before schema defaults are applied.
    if (
      event.type === 'context_package.published' &&
      contextPackageHash(event.payload) !== event.payload.hash
    ) {
      return { known: true, ok: false, issues: ['hash: does not match the package content'] };
    }
    return { known: true, ok: true };
  }
  return {
    known: true,
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}
