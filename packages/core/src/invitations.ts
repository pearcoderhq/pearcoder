import type { KeyObject } from 'node:crypto';
import {
  decodeInvitation,
  encodeInvitation,
  type Invitation,
  InvitationFormatError,
  type SessionId,
} from '@pearcoderhq/protocol';
import { PearcoderError } from './errors.js';

export type InvitationErrorCode =
  | 'INVITE_MALFORMED'
  | 'INVITE_BAD_SIGNATURE'
  | 'INVITE_WRONG_SESSION'
  | 'INVITE_UNKNOWN'
  | 'INVITE_REVOKED'
  | 'INVITE_EXPIRED'
  | 'INVITE_EXHAUSTED';

export class InvitationError extends PearcoderError<InvitationErrorCode> {}

export interface IssueOptions {
  sessionName: string;
  addresses: string[];
  tlsFingerprint?: string;
  role?: Invitation['role'];
  ttlMs?: number;
  maxUses?: number;
}

export interface InvitationRecord {
  invitation: Invitation;
  uses: number;
  revoked: boolean;
}

export const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** Where a persistent host keeps invitations so they survive restarts. */
export interface InvitationPersistence {
  loadInvitations(): InvitationRecord[];
  saveInvitation(record: InvitationRecord): void;
}

/**
 * Host-side registry of issued invitations (threat model T05). The signature proves the host
 * issued a token; this registry decides whether it may still be used.
 */
export class InvitationRegistry {
  readonly #sessionId: SessionId;
  readonly #hostKey: KeyObject;
  readonly #now: () => Date;
  readonly #records = new Map<string, InvitationRecord>();
  readonly #persistence: InvitationPersistence | undefined;

  constructor(
    sessionId: SessionId,
    hostPrivateKey: KeyObject,
    now: () => Date = () => new Date(),
    persistence?: InvitationPersistence,
  ) {
    this.#sessionId = sessionId;
    this.#hostKey = hostPrivateKey;
    this.#now = now;
    this.#persistence = persistence;
    for (const record of persistence?.loadInvitations() ?? []) {
      this.#records.set(record.invitation.invite_id, record);
    }
  }

  issue(options: IssueOptions): { token: string; invitation: Invitation } {
    const issued = encodeInvitation(
      {
        session_id: this.#sessionId,
        session_name: options.sessionName,
        addresses: options.addresses,
        ...(options.tlsFingerprint ? { tls_fingerprint: options.tlsFingerprint } : {}),
        role: options.role ?? 'member',
        expires_at: new Date(
          this.#now().getTime() + (options.ttlMs ?? DEFAULT_INVITE_TTL_MS),
        ).toISOString(),
        max_uses: options.maxUses ?? 1,
      },
      this.#hostKey,
    );
    const record = { invitation: issued.invitation, uses: 0, revoked: false };
    this.#records.set(issued.invitation.invite_id, record);
    this.#persistence?.saveInvitation(record);
    return issued;
  }

  /** Checks a token without consuming a use. */
  check(token: string): InvitationRecord {
    let invitation: Invitation;
    try {
      invitation = decodeInvitation(token);
    } catch (error) {
      if (error instanceof InvitationFormatError) {
        throw new InvitationError(error.code, error.message);
      }
      throw error;
    }
    if (invitation.session_id !== this.#sessionId) {
      throw new InvitationError('INVITE_WRONG_SESSION', 'invitation is for another session');
    }
    const record = this.#records.get(invitation.invite_id);
    // A valid signature by another key, or one we never issued, is unknown here.
    if (!record || record.invitation.host_public_key !== invitation.host_public_key) {
      throw new InvitationError('INVITE_UNKNOWN', 'invitation was not issued by this host');
    }
    if (record.revoked) throw new InvitationError('INVITE_REVOKED', 'invitation was revoked');
    if (Date.parse(record.invitation.expires_at) <= this.#now().getTime()) {
      throw new InvitationError('INVITE_EXPIRED', 'invitation has expired');
    }
    if (record.uses >= record.invitation.max_uses) {
      throw new InvitationError('INVITE_EXHAUSTED', 'invitation has no uses left');
    }
    return record;
  }

  /** Checks a token and consumes one use. */
  redeem(token: string): Invitation {
    const record = this.check(token);
    record.uses += 1;
    this.#persistence?.saveInvitation(record);
    return record.invitation;
  }

  revoke(inviteId: string): boolean {
    const record = this.#records.get(inviteId);
    if (!record) return false;
    record.revoked = true;
    this.#persistence?.saveInvitation(record);
    return true;
  }

  list(): InvitationRecord[] {
    return [...this.#records.values()].map((r) => structuredClone(r));
  }
}
