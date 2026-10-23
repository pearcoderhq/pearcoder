import { createPrivateKey, randomBytes, webcrypto, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { PearcoderError } from '@pearcoderhq/core';
import { certificateFingerprint } from '@pearcoderhq/protocol';

export type TlsErrorCode =
  | 'TLS_KEY_MISMATCH'
  | 'TLS_CERT_EXPIRED'
  | 'TLS_CERT_INVALID'
  | 'TLS_KEY_INSECURE_PERMISSIONS';

export class TlsError extends PearcoderError<TlsErrorCode> {}

export interface TlsMaterial {
  /** PEM certificate, optionally followed by its chain. */
  cert: string;
  /** PEM private key. */
  key: string;
  /** `sha256:<hex>` of the leaf certificate, for invitations. */
  fingerprint: string;
  source: 'generated' | 'provided';
}

const TLS_DIR = 'tls';
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

export function fingerprintOf(certPem: string): string {
  return certificateFingerprint(new X509Certificate(certPem).raw);
}

export interface GenerateOptions {
  /** IP addresses and DNS names for the certificate. Clients pin the fingerprint, so these are informational. */
  hosts: string[];
  validityDays?: number;
  now?: Date;
}

/**
 * Creates a self-signed ECDSA P-256 certificate. The x509 library and its reflect-metadata
 * polyfill are loaded only here (ADR-0004), so hosts with their own certificates never load them.
 */
export async function generateSelfSigned(
  options: GenerateOptions,
): Promise<{ cert: string; key: string }> {
  await import('reflect-metadata');
  const x509 = await import('@peculiar/x509');
  x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = (await webcrypto.subtle.generateKey(algorithm, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  const notBefore = options.now ?? new Date();
  const notAfter = new Date(notBefore.getTime() + (options.validityDays ?? 365) * 86_400_000);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    // Positive 128-bit serial: a leading 01 byte keeps the high bit clear.
    serialNumber: `01${randomBytes(15).toString('hex')}`,
    name: 'CN=Pearcoder session host',
    notBefore,
    notAfter,
    signingAlgorithm: algorithm,
    keys: keys as unknown as Parameters<
      typeof x509.X509CertificateGenerator.createSelfSigned
    >[0]['keys'],
    extensions: [
      new x509.SubjectAlternativeNameExtension(
        options.hosts.map((host) => ({ type: isIP(host) ? 'ip' : 'dns', value: host }) as const),
      ),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
    ],
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const key = createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  return { cert: cert.toString('pem'), key };
}

function assertPrivate(path: string): void {
  if (process.platform === 'win32') return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new TlsError(
      'TLS_KEY_INSECURE_PERMISSIONS',
      `${path} is accessible by other users (mode ${mode.toString(8)}); run chmod go-rwx on it`,
    );
  }
}

function validate(cert: string, key: string, now: Date): void {
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(cert);
  } catch (error) {
    throw new TlsError('TLS_CERT_INVALID', 'certificate is not valid PEM', { cause: error });
  }
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(key);
  } catch (error) {
    throw new TlsError('TLS_CERT_INVALID', 'private key is not valid PEM', { cause: error });
  }
  if (!leaf.checkPrivateKey(privateKey)) {
    throw new TlsError('TLS_KEY_MISMATCH', 'private key does not belong to the certificate');
  }
  if (Date.parse(leaf.validTo) <= now.getTime() || Date.parse(leaf.validFrom) > now.getTime()) {
    throw new TlsError(
      'TLS_CERT_EXPIRED',
      `certificate is not valid now (valid until ${leaf.validTo})`,
    );
  }
}

/**
 * The host's generated certificate in `<home>/tls`, created on first use and renewed within 30
 * days of expiry. Reusing it keeps the fingerprint in outstanding invitations valid.
 */
export async function loadOrCreateTls(
  home: string,
  options: GenerateOptions,
): Promise<TlsMaterial> {
  const now = options.now ?? new Date();
  const dir = join(home, TLS_DIR);
  const certFile = join(dir, 'cert.pem');
  const keyFile = join(dir, 'key.pem');
  if (existsSync(certFile) && existsSync(keyFile)) {
    assertPrivate(dir);
    assertPrivate(keyFile);
    const cert = readFileSync(certFile, 'utf8');
    const key = readFileSync(keyFile, 'utf8');
    const renewable =
      Date.parse(new X509Certificate(cert).validTo) - now.getTime() < RENEW_BEFORE_MS;
    if (!renewable) {
      validate(cert, key, now);
      return { cert, key, fingerprint: fingerprintOf(cert), source: 'generated' };
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { cert, key } = await generateSelfSigned({ ...options, now });
  writeFileSync(keyFile, key, { mode: 0o600 });
  writeFileSync(certFile, cert, { mode: 0o644 });
  assertPrivate(dir);
  assertPrivate(keyFile);
  return { cert, key, fingerprint: fingerprintOf(cert), source: 'generated' };
}

/** A certificate the user already has (company CA, Tailscale, Let's Encrypt, …). */
export function loadProvidedTls(
  certPath: string,
  keyPath: string,
  now: Date = new Date(),
): TlsMaterial {
  assertPrivate(keyPath);
  const cert = readFileSync(certPath, 'utf8');
  const key = readFileSync(keyPath, 'utf8');
  validate(cert, key, now);
  return { cert, key, fingerprint: fingerprintOf(cert), source: 'provided' };
}
