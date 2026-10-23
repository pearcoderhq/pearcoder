import type { KeyObject } from 'node:crypto';
import {
  canonicalJson,
  chainGenesis,
  chainLinkHash,
  checkPayload,
  eventContentHash,
  maxEventBytes,
  ParticipantJoinedSchema,
  PROTOCOL_VERSION,
  publicKeyFromRaw,
  type Role,
  type SequencedEvent,
  type SessionId,
  type SignedEvent,
  SignedEventSchema,
  signingPayload,
  type UserId,
  userIdFromPublicKey,
  verifyEventSignature,
} from '@pearcoderhq/protocol';
import { canAppend } from './acl.js';
import { PearcoderError } from './errors.js';
import {
  DEFAULT_EVENT_RATE_LIMIT,
  type RateLimit,
  RateLimiter,
  REQUEST_RATE_LIMIT,
} from './rate-limit.js';
import { type EventStore, MemoryEventStore } from './store.js';

export type EventRejectionCode =
  | 'INVALID_EVENT'
  | 'UNSUPPORTED_VERSION'
  | 'WRONG_SESSION'
  | 'EVENT_TOO_LARGE'
  | 'UNKNOWN_PARTICIPANT'
  | 'BAD_SIGNATURE'
  | 'INVALID_PAYLOAD'
  | 'EVENT_ID_CONFLICT'
  | 'FORBIDDEN_FOR_ROLE'
  | 'RATE_LIMITED'
  | 'INVALID_JOIN'
  | 'INVALID_REFERENCE'
  | 'NOT_ADDRESSEE'
  | 'DECISION_CLOSED';

export class EventRejectedError extends PearcoderError<EventRejectionCode> {}

export interface AppendResult {
  status: 'appended' | 'duplicate';
  event: SequencedEvent;
}

export interface Participant {
  userId: UserId;
  displayName: string;
  role: Role;
  publicKey: string;
  active: boolean;
}

export type EventListener = (event: SequencedEvent) => void;

export interface SessionLogOptions {
  sessionId: SessionId;
  /** Signs chain link hashes with the host key (threat model T09). Without it events are unsealed. */
  seal?: (hash: string) => string;
  store?: EventStore;
  now?: () => Date;
  maxEventBytes?: number;
  rateLimit?: RateLimit;
}

/**
 * The host's ordered log for one session. Every event must be signed by an active participant
 * whose role allows its type; the host only adds `sequence` and `received_at`.
 * Threat model T02–T04, T06, T07, T10.
 */
export class SessionLog {
  readonly sessionId: SessionId;
  readonly #store: EventStore;
  readonly #now: () => Date;
  readonly #maxEventBytes: number | undefined;
  readonly #limiter: RateLimiter;
  readonly #requestLimiter: RateLimiter;
  readonly #participants = new Map<UserId, Participant & { key: KeyObject }>();
  // Outcomes by decision. A decided decision takes no more stances and can only be superseded.
  readonly #decided = new Map<string, string>();
  readonly #listeners = new Set<EventListener>();
  readonly #seal: ((hash: string) => string) | undefined;

  constructor(options: SessionLogOptions) {
    this.sessionId = options.sessionId;
    this.#seal = options.seal;
    this.#store = options.store ?? new MemoryEventStore();
    this.#now = options.now ?? (() => new Date());
    this.#maxEventBytes = options.maxEventBytes;
    this.#limiter = new RateLimiter(options.rateLimit ?? DEFAULT_EVENT_RATE_LIMIT, () =>
      this.#now().getTime(),
    );
    // Requests notify people, so they get a much tighter budget than chat (M2.9 loop guard).
    this.#requestLimiter = new RateLimiter(REQUEST_RATE_LIMIT, () => this.#now().getTime());
    this.#rebuildParticipants();
  }

  get head(): number {
    return this.#store.head();
  }

  participant(userId: UserId): Participant | undefined {
    const p = this.#participants.get(userId);
    return p && publicParticipant(p);
  }

  participants(): Participant[] {
    return [...this.#participants.values()].map(publicParticipant);
  }

  /**
   * Adds a participant from their self-signed `participant.joined` event. Callers must already
   * have authorised the join (host bootstrap, or a redeemed invitation granting `role`).
   */
  admit(joinEvent: unknown, role: Role): AppendResult {
    const event = this.#parse(joinEvent);
    if (event.type !== 'participant.joined')
      reject('INVALID_JOIN', 'not a participant.joined event');
    const payload = ParticipantJoinedSchema.safeParse(event.payload);
    if (!payload.success) reject('INVALID_JOIN', 'invalid participant.joined payload');
    const { public_key: publicKey, display_name: displayName } = payload.data;
    if (payload.data.role !== role)
      reject('INVALID_JOIN', 'requested role does not match the grant');
    if (userIdFromPublicKey(Buffer.from(publicKey, 'base64url')) !== event.actor_user_id) {
      reject('INVALID_JOIN', 'actor id does not match the presented key');
    }
    let key: KeyObject;
    try {
      key = publicKeyFromRaw(publicKey);
    } catch {
      reject('INVALID_JOIN', 'presented key is not an Ed25519 key');
    }
    if (!verifyEventSignature(event, key)) reject('BAD_SIGNATURE', 'signature does not verify');

    const duplicate = this.#duplicateOf(event);
    if (duplicate) return duplicate;
    const existing = this.#participants.get(event.actor_user_id);
    if (existing?.active) reject('INVALID_JOIN', 'participant is already in the session');

    this.#participants.set(event.actor_user_id, {
      userId: event.actor_user_id,
      displayName,
      role,
      publicKey,
      active: true,
      key,
    });
    return this.#commit(event);
  }

  /** Appends a regular event from an active participant. */
  append(input: unknown): AppendResult {
    const event = this.#parse(input);
    const participant = this.#participants.get(event.actor_user_id);
    if (!participant) reject('UNKNOWN_PARTICIPANT', 'actor is not a participant of this session');
    // The actor id is derived from the key, so a valid signature also proves the claimed actor.
    if (!verifyEventSignature(event, participant.key)) {
      reject('BAD_SIGNATURE', 'signature does not verify');
    }

    const duplicate = this.#duplicateOf(event);
    if (duplicate) return duplicate;

    if (!participant.active) reject('UNKNOWN_PARTICIPANT', 'participant has left the session');
    if (!canAppend(participant.role, event.type)) {
      reject('FORBIDDEN_FOR_ROLE', `${participant.role} may not append ${event.type}`);
    }
    this.#checkReferences(event);
    if (!this.#limiter.take(participant.userId)) reject('RATE_LIMITED', 'too many events');
    if (event.type === 'request.created' && !this.#requestLimiter.take(participant.userId)) {
      reject('RATE_LIMITED', 'too many requests');
    }

    const result = this.#commit(event);
    if (event.type === 'participant.left') participant.active = false;
    return result;
  }

  get(id: string): SequencedEvent | undefined {
    return this.#store.get(id);
  }

  /** Events with `sequence > after`, oldest first, for replay after reconnect. */
  after(after: number, limit = 500): SequencedEvent[] {
    return this.#store.after(after, limit);
  }

  /** Calls `listener` for every newly appended event (not for duplicates). */
  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #parse(input: unknown): SignedEvent {
    const parsed = SignedEventSchema.safeParse(input);
    if (!parsed.success) reject('INVALID_EVENT', 'event does not match the protocol envelope');
    // Host-assigned fields are never taken from the sender (they are outside the signature).
    const event = withoutHostFields(parsed.data as SequencedEvent);
    if (event.version > PROTOCOL_VERSION) {
      reject('UNSUPPORTED_VERSION', `protocol version ${event.version} is newer than this host`);
    }
    if (event.session_id !== this.sessionId)
      reject('WRONG_SESSION', 'event is for another session');
    const limit = this.#maxEventBytes ?? maxEventBytes(event.type);
    if (Buffer.byteLength(canonicalJson(event), 'utf8') > limit) {
      reject('EVENT_TOO_LARGE', `event exceeds ${limit} bytes`);
    }
    const payload = checkPayload(event);
    if (payload.known && !payload.ok) {
      reject('INVALID_PAYLOAD', `invalid ${event.type} payload: ${payload.issues.join('; ')}`);
    }
    return event;
  }

  // Requests, resolutions and findings must point at things that exist in this session.
  #checkReferences(event: SignedEvent): void {
    const payload = event.payload as Record<string, unknown>;
    const expect = (id: unknown, type: string, field: string): SequencedEvent | undefined => {
      if (id === undefined) return undefined;
      const target = this.#store.get(String(id));
      if (target?.type !== type)
        reject('INVALID_REFERENCE', `${field} does not refer to a ${type}`);
      return target;
    };
    if (event.type === 'message.created') {
      const mentioned = [
        ...((payload.mentions ?? []) as UserId[]),
        ...((payload.agent_mentions ?? []) as { user: UserId }[]).map((m) => m.user),
      ];
      for (const userId of mentioned) {
        if (!this.#participants.has(userId)) {
          reject('INVALID_REFERENCE', 'mentions can only name session participants');
        }
      }
    } else if (event.type === 'request.created') {
      for (const userId of payload.to as UserId[]) {
        if (!this.#participants.has(userId)) {
          reject('INVALID_REFERENCE', 'requests can only go to session participants');
        }
      }
      expect(payload.context_package, 'context_package.published', 'context_package');
    } else if (event.type === 'request.resolved') {
      const request = expect(payload.request, 'request.created', 'request');
      const to = (request?.payload.to ?? []) as string[];
      if (
        request &&
        request.actor_user_id !== event.actor_user_id &&
        !to.includes(event.actor_user_id)
      ) {
        reject('NOT_ADDRESSEE', 'only the requester or an addressee can resolve a request');
      }
    } else if (event.type === 'review.finding') {
      expect(payload.request, 'request.created', 'request');
      expect(payload.context_package, 'context_package.published', 'context_package');
    } else if (event.type === 'context_package.published') {
      expect(payload.previous, 'context_package.published', 'previous');
    } else if (event.type === 'finding.resolved') {
      const finding = expect(payload.finding, 'review.finding', 'finding');
      const request = finding?.payload.request
        ? this.#store.get(String(finding.payload.request))
        : undefined;
      const allowed = [finding?.actor_user_id, request?.actor_user_id];
      if (!allowed.includes(event.actor_user_id) && !this.#isHost(event.actor_user_id)) {
        reject(
          'NOT_ADDRESSEE',
          'only the finding author, the requester or the host can resolve it',
        );
      }
    } else if (event.type === 'decision.proposed') {
      for (const id of (payload.related ?? []) as string[]) {
        if (!this.#store.get(id)) reject('INVALID_REFERENCE', 'related events must exist');
      }
    } else if (event.type === 'decision.vote') {
      expect(payload.decision, 'decision.proposed', 'decision');
      if (this.#decided.has(String(payload.decision))) {
        reject('DECISION_CLOSED', 'this decision already has an outcome');
      }
    } else if (event.type === 'decision.resolved') {
      const decision = expect(payload.decision, 'decision.proposed', 'decision');
      if (decision?.actor_user_id !== event.actor_user_id && !this.#isHost(event.actor_user_id)) {
        reject('NOT_ADDRESSEE', 'only the proposer or the host can record the outcome');
      }
      const previous = this.#decided.get(String(payload.decision));
      if (previous && (previous === 'superseded' || payload.outcome !== 'superseded')) {
        reject(
          'DECISION_CLOSED',
          `this decision is already ${previous}; a decided decision can only be superseded`,
        );
      }
    }
  }

  #isHost(userId: UserId): boolean {
    return this.#participants.get(userId)?.role === 'host';
  }

  // Same id and same signed content: an at-least-once resend. Same id, different content: reject.
  #duplicateOf(event: SignedEvent): AppendResult | undefined {
    const stored = this.#store.get(event.id);
    if (!stored) return undefined;
    if (canonicalJson(withoutHostFields(stored)) === canonicalJson(event)) {
      return { status: 'duplicate', event: stored };
    }
    reject('EVENT_ID_CONFLICT', 'a different event with this id already exists');
  }

  #commit(event: SignedEvent): AppendResult {
    const sequence = this.#store.head() + 1;
    const receivedAt = this.#now().toISOString();
    const sequenced: SequencedEvent = {
      ...structuredClone(event),
      sequence,
      received_at: receivedAt,
    };
    if (this.#seal) {
      const prev =
        this.#store.after(sequence - 2, 1)[0]?.chain?.hash ?? chainGenesis(this.sessionId);
      const hash = chainLinkHash({
        prev,
        sequence,
        receivedAt,
        contentHash: eventContentHash(event),
      });
      sequenced.chain = { prev, hash, sig: this.#seal(hash) };
    }
    this.#store.append(sequenced);
    for (const listener of this.#listeners) {
      try {
        listener(structuredClone(sequenced));
      } catch {
        // A failing subscriber must not break appends for everyone else.
      }
    }
    if (sequenced.type === 'decision.resolved') {
      this.#decided.set(String(sequenced.payload.decision), String(sequenced.payload.outcome));
    }
    return { status: 'appended', event: sequenced };
  }

  // Restores the participant registry from a persisted log (signatures were checked on append).
  #rebuildParticipants(): void {
    for (let cursor = 0; cursor < this.#store.head(); ) {
      const batch = this.#store.after(cursor, 1000);
      if (batch.length === 0) break;
      for (const event of batch) {
        if (event.type === 'participant.joined') {
          const payload = ParticipantJoinedSchema.parse(event.payload);
          this.#participants.set(event.actor_user_id, {
            userId: event.actor_user_id,
            displayName: payload.display_name,
            role: payload.role,
            publicKey: payload.public_key,
            active: true,
            key: publicKeyFromRaw(payload.public_key),
          });
        } else if (event.type === 'participant.left') {
          const p = this.#participants.get(event.actor_user_id);
          if (p) p.active = false;
        } else if (event.type === 'decision.resolved') {
          this.#decided.set(String(event.payload.decision), String(event.payload.outcome));
        }
        cursor = event.sequence;
      }
    }
  }
}

function withoutHostFields(event: SequencedEvent): SignedEvent {
  return { ...signingPayload(event), sig: event.sig } as SignedEvent;
}

function publicParticipant(p: Participant & { key: KeyObject }): Participant {
  return {
    userId: p.userId,
    displayName: p.displayName,
    role: p.role,
    publicKey: p.publicKey,
    active: p.active,
  };
}

function reject(code: EventRejectionCode, message: string): never {
  throw new EventRejectedError(code, message);
}
