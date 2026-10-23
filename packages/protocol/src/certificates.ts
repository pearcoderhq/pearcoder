import { createHash } from 'node:crypto';

/** `sha256:<hex>` of a DER-encoded certificate: the value carried in `tls_fingerprint`. */
export function certificateFingerprint(der: Uint8Array): string {
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}
