import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { type SignedEvent, signingPayload } from './envelope.js';

// The host seals its log into a hash chain (threat model T09): each sequenced event commits to the
// previous one, its own sequence and receive time, and the author-signed content. The host signs
// each link, so an exported log cannot lose, reorder or re-time events without verification
// failing. A log cut short at the end still verifies, as a prefix of the host's history.

export const CHAIN_VERSION = 'chain-v1';

export interface ChainLink {
  /** Hash of the previous link (`genesis` value for the first event). */
  prev: string;
  /** sha256 hex of this link. */
  hash: string;
  /** Host's Ed25519 signature over `hash`, base64url. */
  sig: string;
}

export function chainGenesis(sessionId: string): string {
  return createHash('sha256').update(`pearcoder-chain-v1\n${sessionId}`).digest('hex');
}

/** sha256 of the author-signed event (everything except host fields). */
export function eventContentHash(event: SignedEvent): string {
  return createHash('sha256')
    .update(canonicalJson({ ...signingPayload(event), sig: event.sig }))
    .digest('hex');
}

export function chainLinkHash(input: {
  prev: string;
  sequence: number;
  receivedAt: string;
  contentHash: string;
}): string {
  return createHash('sha256')
    .update(
      ['pearcoder-chain-v1', input.prev, input.sequence, input.receivedAt, input.contentHash].join(
        '\n',
      ),
    )
    .digest('hex');
}
