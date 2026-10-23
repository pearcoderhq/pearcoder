import { createPublicKey, type KeyObject, sign, verify } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { type SignedEvent, signingPayload, type UnsignedEvent } from './envelope.js';
import { keyIdFromPublicKey } from './ids.js';

export function rawPublicKey(key: KeyObject): Buffer {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new TypeError('expected an Ed25519 key');
  }
  return Buffer.from(jwk.x, 'base64url');
}

export function publicKeyFromRaw(raw: string | Uint8Array): KeyObject {
  const x = typeof raw === 'string' ? raw : Buffer.from(raw).toString('base64url');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
}

export function eventSigningBytes(event: UnsignedEvent | SignedEvent): Buffer {
  return Buffer.from(canonicalJson(signingPayload(event)), 'utf8');
}

export function signEvent(event: UnsignedEvent, privateKey: KeyObject): SignedEvent {
  const signature = sign(null, eventSigningBytes(event), privateKey);
  return {
    ...signingPayload(event),
    sig: {
      alg: 'ed25519',
      key_id: keyIdFromPublicKey(rawPublicKey(privateKey)),
      value: signature.toString('base64url'),
    },
  } as SignedEvent;
}

// True only if the signature is valid for this exact event and was made by `publicKey`.
export function verifyEventSignature(event: SignedEvent, publicKey: KeyObject): boolean {
  if (event.sig.key_id !== keyIdFromPublicKey(rawPublicKey(publicKey))) return false;
  try {
    return verify(
      null,
      eventSigningBytes(event),
      publicKey,
      Buffer.from(event.sig.value, 'base64url'),
    );
  } catch {
    return false;
  }
}
