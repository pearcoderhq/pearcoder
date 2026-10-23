import {
  CHAIN_VERSION,
  newEventId,
  newSessionId,
  ParticipantJoinedSchema,
  PROTOCOL_VERSION,
  type SessionId,
  signEvent,
  signProof,
} from '@pearcoderhq/protocol';
import type { DeviceIdentity } from './identity.js';
import {
  type InvitationPersistence,
  InvitationRegistry,
  type IssueOptions,
} from './invitations.js';
import type { RateLimit } from './rate-limit.js';
import { type AppendResult, SessionLog } from './session-log.js';
import type { EventStore } from './store.js';

export interface HostSessionOptions {
  identity: DeviceIdentity;
  displayName: string;
  sessionName: string;
  sessionId?: SessionId;
  store?: EventStore;
  invitationPersistence?: InvitationPersistence;
  now?: () => Date;
  rateLimit?: RateLimit;
}

/** A session hosted on this device: the log plus the invitations that admit new participants. */
export class HostSession {
  readonly log: SessionLog;
  readonly invitations: InvitationRegistry;
  readonly sessionName: string;
  readonly #identity: DeviceIdentity;

  private constructor(options: HostSessionOptions & { sessionId: SessionId }) {
    const now = options.now ?? (() => new Date());
    this.#identity = options.identity;
    this.sessionName = options.sessionName;
    this.log = new SessionLog({
      sessionId: options.sessionId,
      seal: (hash) => signProof(Buffer.from(hash, 'utf8'), options.identity.privateKey),
      now,
      ...(options.store ? { store: options.store } : {}),
      ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    });
    this.invitations = new InvitationRegistry(
      options.sessionId,
      options.identity.privateKey,
      now,
      options.invitationPersistence,
    );
  }

  /** Creates (or reopens, when the store already has history) a session hosted by `identity`. */
  static create(options: HostSessionOptions): HostSession {
    const session = new HostSession({ ...options, sessionId: options.sessionId ?? newSessionId() });
    if (!session.log.participant(options.identity.userId)) {
      const now = options.now ?? (() => new Date());
      session.log.admit(
        signEvent(
          {
            id: newEventId(),
            session_id: session.log.sessionId,
            timestamp: now().toISOString(),
            actor_user_id: options.identity.userId,
            type: 'participant.joined',
            thread_id: 'main',
            version: PROTOCOL_VERSION,
            payload: {
              display_name: options.displayName,
              public_key: options.identity.publicKey,
              key_id: options.identity.keyId,
              role: 'host',
              // Signed promise that every event is sealed, so a stripped chain can't pass as an
              // export from an older host.
              seals: CHAIN_VERSION,
            },
          },
          options.identity.privateKey,
        ),
        'host',
      );
    }
    return session;
  }

  get sessionId(): SessionId {
    return this.log.sessionId;
  }

  #inviteDefaults: Pick<IssueOptions, 'addresses' | 'tlsFingerprint'> | undefined;

  /** Where joiners reach this host; used for invitations created through the API. */
  setInviteDefaults(defaults: Pick<IssueOptions, 'addresses' | 'tlsFingerprint'>): void {
    this.#inviteDefaults = defaults;
  }

  get inviteDefaults(): Pick<IssueOptions, 'addresses' | 'tlsFingerprint'> | undefined {
    return this.#inviteDefaults;
  }

  invite(options: Omit<IssueOptions, 'sessionName'>) {
    return this.invitations.issue({ ...options, sessionName: this.sessionName });
  }

  /**
   * Admits a joiner who presents an invitation and their self-signed `participant.joined` event.
   * The event is validated before the invitation use is consumed, so a bad join attempt cannot
   * burn someone else's single-use invitation.
   */
  join(token: string, joinEvent: unknown): AppendResult {
    // A resent join (e.g. after a dropped connection) is answered from the log, even if a
    // single-use invitation is already used up.
    const id = (joinEvent as { id?: unknown } | null)?.id;
    const stored = typeof id === 'string' ? this.log.get(id) : undefined;
    if (stored?.type === 'participant.joined') {
      return this.log.admit(joinEvent, ParticipantJoinedSchema.parse(stored.payload).role);
    }
    const { invitation } = this.invitations.check(token);
    const result = this.log.admit(joinEvent, invitation.role);
    if (result.status === 'appended') this.invitations.redeem(token);
    return result;
  }

  get hostUserId() {
    return this.#identity.userId;
  }

  /** Signs an auth proof with the host device key, without exposing the key. */
  signAsHost(message: Buffer): string {
    return signProof(message, this.#identity.privateKey);
  }
}
