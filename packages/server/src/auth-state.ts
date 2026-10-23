import { randomBytes } from 'node:crypto';
import type { SessionId, UserId } from '@pearcoderhq/protocol';

export const CHALLENGE_TTL_MS = 60_000;
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PENDING_CHALLENGES = 10_000;

interface Challenge {
  sessionId: SessionId;
  clientNonce: string;
  expiresAt: number;
}

export interface SessionToken {
  sessionId: SessionId;
  userId: UserId;
  expiresAt: number;
}

/** One-time login challenges and the bearer tokens they produce. In memory: a restart logs everyone out. */
export class AuthState {
  readonly #now: () => number;
  readonly #challenges = new Map<string, Challenge>();
  readonly #tokens = new Map<string, SessionToken>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  createChallenge(
    sessionId: SessionId,
    clientNonce: string,
  ): { hostNonce: string; expiresAt: number } {
    this.#sweep();
    if (this.#challenges.size >= MAX_PENDING_CHALLENGES) {
      // Bounded memory under a challenge flood (threat model T07); the oldest entry goes first.
      const oldest = this.#challenges.keys().next().value;
      if (oldest !== undefined) this.#challenges.delete(oldest);
    }
    const hostNonce = randomBytes(24).toString('base64url');
    const expiresAt = this.#now() + CHALLENGE_TTL_MS;
    this.#challenges.set(hostNonce, { sessionId, clientNonce, expiresAt });
    return { hostNonce, expiresAt };
  }

  /** Removes and returns a challenge; each host nonce can be answered at most once (T04). */
  consumeChallenge(hostNonce: string): Challenge | undefined {
    const challenge = this.#challenges.get(hostNonce);
    this.#challenges.delete(hostNonce);
    if (!challenge || challenge.expiresAt <= this.#now()) return undefined;
    return challenge;
  }

  issueToken(sessionId: SessionId, userId: UserId): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + TOKEN_TTL_MS;
    this.#tokens.set(token, { sessionId, userId, expiresAt });
    return { token, expiresAt };
  }

  resolveToken(token: string): SessionToken | undefined {
    const entry = this.#tokens.get(token);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#tokens.delete(token);
      return undefined;
    }
    return entry;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [nonce, challenge] of this.#challenges) {
      if (challenge.expiresAt <= now) this.#challenges.delete(nonce);
    }
  }
}
