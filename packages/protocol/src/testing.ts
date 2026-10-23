import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { SignedEvent, UnsignedEvent } from './envelope.js';
import { PROTOCOL_VERSION } from './envelope.js';
import {
  keyIdFromPublicKey,
  newEventId,
  newSessionId,
  type SessionId,
  type UserId,
  userIdFromPublicKey,
} from './ids.js';
import { rawPublicKey, signEvent } from './signing.js';

export interface TestKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  userId: UserId;
}

export function testKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, userId: userIdFromPublicKey(rawPublicKey(publicKey)) };
}

export function testEvent(
  actor: UserId,
  overrides: Partial<UnsignedEvent> & { session_id?: SessionId } = {},
): UnsignedEvent {
  return {
    id: newEventId(),
    session_id: newSessionId(),
    timestamp: new Date('2026-10-22T10:00:00.000Z').toISOString(),
    actor_user_id: actor,
    type: 'message.created',
    thread_id: 'main',
    version: PROTOCOL_VERSION,
    payload: { text: 'hello' },
    ...overrides,
  };
}

export function testJoinEvent(
  key: TestKey,
  sessionId: SessionId,
  role: 'host' | 'member' | 'observer',
  displayName = 'Tester',
): SignedEvent {
  const raw = rawPublicKey(key.publicKey);
  return signEvent(
    testEvent(key.userId, {
      session_id: sessionId,
      type: 'participant.joined',
      payload: {
        display_name: displayName,
        public_key: raw.toString('base64url'),
        key_id: keyIdFromPublicKey(raw),
        role,
      },
    }),
    key.privateKey,
  );
}
