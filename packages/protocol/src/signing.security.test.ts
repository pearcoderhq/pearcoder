// Covers: T02, T03
import { describe, expect, it } from 'vitest';
import type { SignedEvent } from './envelope.js';
import { publicKeyFromRaw, rawPublicKey, signEvent, verifyEventSignature } from './signing.js';
import { testEvent, testKey } from './testing.js';

describe('event signatures', () => {
  const alice = testKey();
  const mallory = testKey();

  it('verifies an untouched event with the author key', () => {
    const signed = signEvent(testEvent(alice.userId), alice.privateKey);
    expect(verifyEventSignature(signed, alice.publicKey)).toBe(true);
  });

  it('verifies after a JSON round trip and with a key rebuilt from raw bytes', () => {
    const signed = signEvent(testEvent(alice.userId), alice.privateKey);
    const wire = JSON.parse(JSON.stringify(signed)) as SignedEvent;
    expect(verifyEventSignature(wire, publicKeyFromRaw(rawPublicKey(alice.publicKey)))).toBe(true);
  });

  it.each([
    ['payload', (e: SignedEvent) => ({ ...e, payload: { text: 'changed' } })],
    ['type', (e: SignedEvent) => ({ ...e, type: 'message.deleted' })],
    ['actor', (e: SignedEvent) => ({ ...e, actor_user_id: mallory.userId })],
    ['timestamp', (e: SignedEvent) => ({ ...e, timestamp: '2030-01-01T00:00:00.000Z' })],
    ['unknown field', (e: SignedEvent) => ({ ...e, injected: 'x' })],
  ])('rejects a tampered %s', (_name, tamper) => {
    const signed = signEvent(
      testEvent(alice.userId, { payload: { text: 'original' } }),
      alice.privateKey,
    );
    expect(verifyEventSignature(tamper(signed) as SignedEvent, alice.publicKey)).toBe(false);
  });

  it('ignores host-assigned fields, so the host can sequence without breaking signatures', () => {
    const signed = signEvent(testEvent(alice.userId), alice.privateKey);
    const sequenced = { ...signed, sequence: 7, received_at: '2026-10-22T10:00:01.000Z' };
    expect(verifyEventSignature(sequenced, alice.publicKey)).toBe(true);
  });

  it('rejects a signature from another key, even with the key id swapped', () => {
    const forged = signEvent(testEvent(alice.userId), mallory.privateKey);
    expect(verifyEventSignature(forged, alice.publicKey)).toBe(false);
    const relabeled = {
      ...forged,
      sig: {
        ...forged.sig,
        key_id: signEvent(testEvent(alice.userId), alice.privateKey).sig.key_id,
      },
    };
    expect(verifyEventSignature(relabeled, alice.publicKey)).toBe(false);
  });

  it('rejects garbage signature bytes without throwing', () => {
    const signed = signEvent(testEvent(alice.userId), alice.privateKey);
    expect(
      verifyEventSignature({ ...signed, sig: { ...signed.sig, value: 'AAAA' } }, alice.publicKey),
    ).toBe(false);
  });
});
