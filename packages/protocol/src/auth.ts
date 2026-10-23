import { type KeyObject, sign, verify } from 'node:crypto';
import type { SessionId, UserId } from './ids.js';

// Challenge-response login to a session host. Both sides sign line-based messages that start
// with a fixed context string, so they can never be confused with event signatures (which sign
// canonical JSON starting with `{`).
const CONTEXT = 'pearcoder-auth-v1';

export interface HostProofInput {
  sessionId: SessionId;
  hostUserId: UserId;
  clientNonce: string;
  hostNonce: string;
}

export interface ClientProofInput {
  sessionId: SessionId;
  hostUserId: UserId;
  userId: UserId;
  hostNonce: string;
  clientNonce: string;
}

/** Signed by the host so a client knows it reached the host named in its invitation. */
export function hostProofMessage(input: HostProofInput): Buffer {
  return Buffer.from(
    [CONTEXT, 'host', input.sessionId, input.hostUserId, input.clientNonce, input.hostNonce].join(
      '\n',
    ),
    'utf8',
  );
}

/** Signed by the client to prove it holds the key behind `userId`. */
export function clientProofMessage(input: ClientProofInput): Buffer {
  return Buffer.from(
    [
      CONTEXT,
      'client',
      input.sessionId,
      input.hostUserId,
      input.userId,
      input.hostNonce,
      input.clientNonce,
    ].join('\n'),
    'utf8',
  );
}

export function signProof(message: Buffer, privateKey: KeyObject): string {
  return sign(null, message, privateKey).toString('base64url');
}

export function verifyProof(message: Buffer, signature: string, publicKey: KeyObject): boolean {
  try {
    return verify(null, message, publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
