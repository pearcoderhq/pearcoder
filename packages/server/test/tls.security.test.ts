// Covers: T08
import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startSessionServer } from '../src/server.js';
import {
  fingerprintOf,
  generateSelfSigned,
  loadOrCreateTls,
  loadProvidedTls,
  TlsError,
} from '../src/tls.js';

const posix = process.platform !== 'win32';
const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearcoder-tls-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tlsCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof TlsError) return error.code;
    throw error;
  }
  return 'accepted';
}

function writePair(dir: string, pair: { cert: string; key: string }) {
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  writeFileSync(certPath, pair.cert);
  writeFileSync(keyPath, pair.key, { mode: 0o600 });
  return { certPath, keyPath };
}

describe('generated certificates', () => {
  it('creates a P-256 certificate for the given hosts', async () => {
    const pair = await generateSelfSigned({ hosts: ['127.0.0.1', 'pearcoder.local'] });
    const cert = new X509Certificate(pair.cert);
    expect(fingerprintOf(pair.cert)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(cert.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(cert.subjectAltName).toContain('DNS:pearcoder.local');
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  });

  it('reuses the stored certificate so invitation fingerprints stay valid', async () => {
    const home = tempDir();
    const first = await loadOrCreateTls(home, { hosts: ['127.0.0.1'] });
    const second = await loadOrCreateTls(home, { hosts: ['10.0.0.9'] });
    expect(second.fingerprint).toBe(first.fingerprint);
    if (posix) {
      expect(statSync(join(home, 'tls')).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, 'tls', 'key.pem')).mode & 0o777).toBe(0o600);
    }
  });

  it('renews a certificate that expires within 30 days', async () => {
    const home = tempDir();
    const old = await loadOrCreateTls(home, {
      hosts: ['127.0.0.1'],
      now: new Date(Date.now() - 350 * 86_400_000),
    });
    const renewed = await loadOrCreateTls(home, { hosts: ['127.0.0.1'] });
    expect(renewed.fingerprint).not.toBe(old.fingerprint);
  });
});

describe('provided certificates', () => {
  it('accepts a valid certificate and key', async () => {
    const pair = await generateSelfSigned({ hosts: ['host.example'] });
    const { certPath, keyPath } = writePair(tempDir(), pair);
    const material = loadProvidedTls(certPath, keyPath);
    expect(material).toMatchObject({ source: 'provided', fingerprint: fingerprintOf(pair.cert) });
  });

  it('rejects a key that does not belong to the certificate', async () => {
    const a = await generateSelfSigned({ hosts: ['a.example'] });
    const b = await generateSelfSigned({ hosts: ['b.example'] });
    const { certPath, keyPath } = writePair(tempDir(), { cert: a.cert, key: b.key });
    expect(tlsCode(() => loadProvidedTls(certPath, keyPath))).toBe('TLS_KEY_MISMATCH');
  });

  it('rejects expired certificates and invalid PEM', async () => {
    const expired = await generateSelfSigned({
      hosts: ['old.example'],
      validityDays: 30,
      now: new Date(Date.now() - 400 * 86_400_000),
    });
    const paths = writePair(tempDir(), expired);
    expect(tlsCode(() => loadProvidedTls(paths.certPath, paths.keyPath))).toBe('TLS_CERT_EXPIRED');
    const garbage = writePair(tempDir(), { cert: 'nope', key: 'nope' });
    expect(tlsCode(() => loadProvidedTls(garbage.certPath, garbage.keyPath))).toBe(
      'TLS_CERT_INVALID',
    );
  });

  it.runIf(posix)('rejects a private key readable by other users', async () => {
    const pair = await generateSelfSigned({ hosts: ['host.example'] });
    const { certPath, keyPath } = writePair(tempDir(), pair);
    chmodSync(keyPath, 0o644);
    expect(tlsCode(() => loadProvidedTls(certPath, keyPath))).toBe('TLS_KEY_INSECURE_PERMISSIONS');
  });
});

describe('TLS session server and pinning (T08)', () => {
  it('refuses to listen beyond loopback without TLS', async () => {
    await expect(startSessionServer({ sessions: new Map(), hostname: '0.0.0.0' })).rejects.toThrow(
      /requires TLS/,
    );
  });
});
