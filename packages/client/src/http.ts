import { type Agent as HttpAgent, request as httpRequest } from 'node:http';
import { type Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { ClientError } from './errors.js';

export interface Endpoint {
  /** `https://host:port`, or `http://` for loopback only. */
  baseUrl: string;
  agent?: HttpAgent | HttpsAgent;
}

export interface RequestOptions {
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** JSON request to the host. Throws ClientError with the host's error code on non-2xx. */
export function requestJson<T>(
  endpoint: Endpoint,
  method: 'GET' | 'POST',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  return attempt<T>(endpoint, method, path, options, false);
}

function attempt<T>(
  endpoint: Endpoint,
  method: 'GET' | 'POST',
  path: string,
  options: RequestOptions,
  retried: boolean,
): Promise<T> {
  const url = new URL(path, endpoint.baseUrl);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise<T>((resolve, reject) => {
    const req = send(
      url,
      {
        method,
        ...(endpoint.agent ? { agent: endpoint.agent } : {}),
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new ClientError('RESPONSE_TOO_LARGE', 'host response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          let body: unknown;
          try {
            body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          } catch {
            reject(new ClientError('INVALID_RESPONSE', 'host sent invalid JSON', res.statusCode));
            return;
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve(body as T);
            return;
          }
          const error = (body as { error?: { code?: unknown; message?: unknown } }).error;
          reject(
            new ClientError(
              typeof error?.code === 'string' ? error.code : `HTTP_${status}`,
              typeof error?.message === 'string' ? error.message : `host returned ${status}`,
              status,
            ),
          );
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(options.timeoutMs ?? 15_000, () =>
      req.destroy(new ClientError('TIMEOUT', `${method} ${url.pathname} timed out`)),
    );
    req.on('error', (error) => {
      // A pooled keep-alive socket can belong to a server that has since restarted (a resumed
      // host on the same port). Node's guidance: retry once on a fresh socket. Safe here because
      // event writes are idempotent by id.
      const code = (error as NodeJS.ErrnoException).code;
      if (!retried && req.reusedSocket && (code === 'ECONNRESET' || code === 'EPIPE')) {
        attempt<T>(endpoint, method, path, options, true).then(resolve, reject);
        return;
      }
      reject(
        error instanceof ClientError
          ? error
          : new ClientError('NETWORK', error.message, undefined, { cause: error }),
      );
    });
    req.end(payload);
  });
}
