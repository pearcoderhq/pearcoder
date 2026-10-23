// Browser-facing protections for a server that usually listens on loopback (threat model T16):
// a malicious page can make the browser send requests to 127.0.0.1, and DNS rebinding can make
// such requests look same-origin. Requests must name an allowed Host, and browser requests
// (which carry Origin) must come from an allowed origin.

export interface GuardConfig {
  /** Lowercase `host:port` values accepted in the Host header. */
  allowedHosts: ReadonlySet<string>;
  /** Exact origins (scheme://host:port) allowed to call the API from a browser. */
  allowedOrigins: ReadonlySet<string>;
}

export type GuardFailure = 'HOST_NOT_ALLOWED' | 'ORIGIN_NOT_ALLOWED';

export function checkRequest(
  config: GuardConfig,
  host: string | undefined,
  origin: string | undefined,
): GuardFailure | undefined {
  if (!host || !config.allowedHosts.has(host.toLowerCase())) return 'HOST_NOT_ALLOWED';
  if (origin !== undefined && !config.allowedOrigins.has(origin)) return 'ORIGIN_NOT_ALLOWED';
  return undefined;
}

export function loopbackHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}
