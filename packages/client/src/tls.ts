import { X509Certificate } from 'node:crypto';
import { Agent } from 'node:https';
import { isIP } from 'node:net';
import { connect, type PeerCertificate } from 'node:tls';
import { certificateFingerprint } from '@pearcoderhq/protocol';
import { ClientError } from './errors.js';

/** Reads the certificate a TLS server presents, without sending any application data. */
export function fetchPeerCertificate(host: string, port: number): Promise<PeerCertificate> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host,
      port,
      ...(isIP(host) ? {} : { servername: host }),
      // Only reads the certificate; trust is decided by the caller from its fingerprint.
      rejectUnauthorized: false,
    });
    socket.setTimeout(10_000, () =>
      socket.destroy(new ClientError('TIMEOUT', 'TLS probe timed out')),
    );
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(true);
      socket.end();
      resolve(cert);
    });
    socket.once('error', (error) =>
      reject(
        error instanceof ClientError
          ? error
          : new ClientError('NETWORK', error.message, undefined, { cause: error }),
      ),
    );
  });
}

/**
 * An HTTPS agent that trusts exactly one certificate, the one whose fingerprint came from the
 * invitation (ADR-0004, threat model T08). The certificate is fetched once, compared, and then
 * used as the only trust anchor, so every later connection is verified by TLS itself. Node skips
 * identity callbacks for self-signed certificates, so a callback alone would not pin.
 */
export async function pinnedAgent(host: string, port: number, fingerprint: string): Promise<Agent> {
  const peer = await fetchPeerCertificate(host, port);
  if (certificateFingerprint(peer.raw) !== fingerprint) {
    throw new ClientError(
      'TLS_FINGERPRINT_MISMATCH',
      'host certificate does not match the invitation',
    );
  }
  return new Agent({
    ca: new X509Certificate(peer.raw).toString(),
    keepAlive: true,
    // The pinned certificate replaces hostname checks: LAN addresses change, the key does not.
    checkServerIdentity: (_host, cert) =>
      certificateFingerprint(cert.raw) === fingerprint
        ? undefined
        : new ClientError('TLS_FINGERPRINT_MISMATCH', 'host certificate changed'),
  });
}
