import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';

/** Hash of a context package payload, excluding its own `hash` field. */
export function contextPackageHash(payload: Record<string, unknown>): string {
  const { hash: _ignored, ...rest } = payload;
  return `sha256:${createHash('sha256').update(canonicalJson(rest)).digest('hex')}`;
}

export function withContextPackageHash<T extends Record<string, unknown>>(
  payload: T,
): T & { hash: string } {
  return { ...payload, hash: contextPackageHash(payload) };
}
