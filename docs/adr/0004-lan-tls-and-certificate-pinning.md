# ADR-0004: TLS for LAN sessions with certificate pinning

- Status: accepted
- Date: 2026-10-22
- Plan task: M1.6b
- Threat model: T08

## Context

A host that listens beyond loopback (`--lan`, or any non-loopback `--bind`) must encrypt traffic and let joiners know they reached the real host. Session hosts are developer laptops with changing LAN addresses, so a public CA is usually not an option. Some teams already have certificates: a company CA, Tailscale (`tailscale cert`), or Let's Encrypt.

Node can parse X.509 certificates but cannot create them. docs/invariants.md requires an ADR before adding a crypto dependency.

## Decision

1. **Beyond loopback means TLS.** `startSessionServer` refuses a non-loopback hostname without TLS material (`INSECURE_BIND`). TLS 1.3 minimum.
2. **Generated certificates by default.** On first LAN use the host creates a self-signed ECDSA P-256 certificate with `@peculiar/x509` (MIT). It is stored in `~/.pearcoder/tls/` (key 0600, directory 0700) and reused, so fingerprints in outstanding invitations stay valid. It is valid for 365 days and renewed within 30 days of expiry; renewal changes the fingerprint, so new invitations are needed.
3. **Bring your own certificate.** `loadProvidedTls(certPath, keyPath)` accepts any PEM certificate (with chain) and key. It checks that the key matches the certificate, that the certificate is valid now, and that the key file isn't readable by other users.
4. **Pinning.** The invitation's `tls_fingerprint` is the SHA-256 of the leaf certificate. Joiners (`pinnedAgent`) open a probe connection that only reads the certificate, compare its fingerprint, and then use that exact certificate as the only trust anchor for all requests. Every real connection is therefore verified by TLS itself. Node skips custom identity checks for self-signed certificates, so a callback alone would not pin.
   - Generated certificates are always pinned.
   - Provided certificates are pinned by default. A host with an auto-renewing CA certificate can leave `tls_fingerprint` out of invitations; joiners then use normal CA validation.
   - The login handshake still proves the host's device key in both cases, so a valid certificate alone can't impersonate a host.
5. **Lazy loading.** `@peculiar/x509` needs the `reflect-metadata` polyfill, which patches the global `Reflect` object. Both are loaded with dynamic `import()` only while generating a certificate. Hosts using loopback or their own certificate never load them.

## Consequences

- Two new runtime dependencies in `@pearcoderhq/server`: `@peculiar/x509` 2.2.0 (with its `@peculiar/asn1-*` and `tsyringe` dependencies) and `reflect-metadata` 0.2.2 (Apache-2.0). They are pinned, and Dependabot tracks them.
- Browsers never connect to a remote host directly: the UI talks to the local node over loopback, so self-signed certificates cause no browser warnings.
- A changed certificate (renewal, new machine) breaks pinning for old invitations by design.
- Revisit if Node gains certificate generation (then drop the dependency), or if pinning by public key (SPKI) becomes preferable to survive renewals with the same key.

## Alternatives considered

- **`selfsigned`:** built on `node-forge`, a larger and older codebase. Rejected.
- **Calling `openssl`:** not installed by default on Windows. Rejected.
- **Hand-written ASN.1 certificate builder:** avoids dependencies but is error-prone security code. Rejected per docs/invariants.md, engineering rules.
- **No TLS, relying on signed events:** signatures protect integrity, not confidentiality. Rejected.
