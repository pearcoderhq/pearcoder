import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

// Identifiers are a short type prefix plus base64url. User and key ids are derived from the
// device public key, so they cannot be claimed without holding the private key.
const FINGERPRINT_LENGTH = 26;
const b64 = '[A-Za-z0-9_-]';

export const UserIdSchema = z.string().regex(new RegExp(`^u_${b64}{${FINGERPRINT_LENGTH}}$`));
export const KeyIdSchema = z.string().regex(new RegExp(`^k_${b64}{${FINGERPRINT_LENGTH}}$`));
export const AgentIdSchema = z.string().regex(new RegExp(`^a_${b64}{8,64}$`));
export const SessionIdSchema = z.string().regex(new RegExp(`^s_${b64}{22}$`));
export const ThreadIdSchema = z.union([
  z.literal('main'),
  z.string().regex(new RegExp(`^t_${b64}{22}$`)),
]);
export const EventIdSchema = z.uuid();

export type UserId = z.infer<typeof UserIdSchema>;
export type KeyId = z.infer<typeof KeyIdSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type ThreadId = z.infer<typeof ThreadIdSchema>;

export function fingerprint(rawPublicKey: Uint8Array): string {
  return createHash('sha256').update(rawPublicKey).digest('base64url').slice(0, FINGERPRINT_LENGTH);
}

export function userIdFromPublicKey(rawPublicKey: Uint8Array): UserId {
  return `u_${fingerprint(rawPublicKey)}`;
}

export function keyIdFromPublicKey(rawPublicKey: Uint8Array): KeyId {
  return `k_${fingerprint(rawPublicKey)}`;
}

export function newSessionId(): SessionId {
  return `s_${randomBytes(16).toString('base64url')}`;
}

export function newThreadId(): ThreadId {
  return `t_${randomBytes(16).toString('base64url')}`;
}

export function newEventId(): string {
  return randomUUID();
}
