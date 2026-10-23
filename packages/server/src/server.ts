import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { getRequestListener } from '@hono/node-server';
import type { HostSession, RateLimit } from '@pearcoderhq/core';
import {
  MAX_ANY_EVENT_BYTES,
  type SequencedEvent,
  type SessionId,
  WS_AUTH_PREFIX,
  WS_PROTOCOL,
} from '@pearcoderhq/protocol';
import { type WebSocket, WebSocketServer } from 'ws';
import { type AppContext, assertActor, createApp, resolveBearer, sessionFor } from './app.js';
import { AuthState } from './auth-state.js';
import { HttpError, toErrorResponse } from './errors.js';
import { checkRequest, loopbackHosts } from './guards.js';
import type { TlsMaterial } from './tls.js';

const MAX_WS_MESSAGE_BYTES = MAX_ANY_EVENT_BYTES + 64 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;

export interface SessionServerOptions {
  sessions: Map<SessionId, HostSession>;
  /** Defaults to loopback. Anything else must be an explicit choice (docs/invariants.md, invariant 6). */
  hostname?: string;
  port?: number;
  /** Extra hostnames or IPs (no port) to accept in the Host header, e.g. LAN addresses. */
  extraHostnames?: string[];
  /** Browser origins allowed to call the API (the local web UI). */
  allowedOrigins?: string[];
  now?: () => number;
  /** Per remote address, for join/challenge/token. */
  anonymousRateLimit?: RateLimit;
  /** Required for any non-loopback hostname (threat model T08). */
  tls?: Pick<TlsMaterial, 'cert' | 'key'>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export interface RunningSessionServer {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

export async function startSessionServer(
  options: SessionServerOptions,
): Promise<RunningSessionServer> {
  const hostname = options.hostname ?? '127.0.0.1';
  if (!LOOPBACK.has(hostname) && !options.tls) {
    throw new HttpError(500, 'INSECURE_BIND', 'listening beyond loopback requires TLS');
  }
  const allowedHosts = new Set<string>();
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const ctx: AppContext = {
    sessions: options.sessions,
    auth: new AuthState(options.now),
    guards: { allowedHosts, allowedOrigins },
    ...(options.now ? { now: options.now } : {}),
    ...(options.anonymousRateLimit ? { anonymousRateLimit: options.anonymousRateLimit } : {}),
  };
  const app = createApp(ctx);
  const listener = getRequestListener(app.fetch);
  const server: Server = options.tls
    ? createTlsServer(
        { cert: options.tls.cert, key: options.tls.key, minVersion: 'TLSv1.3' },
        listener,
      )
    : createServer(listener);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_MESSAGE_BYTES,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  server.on('upgrade', (req, socket, head) => handleUpgrade(ctx, wss, req, socket, head));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, hostname, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  // The Host allowlist needs the real port, known only after listening.
  for (const host of loopbackHosts(port)) allowedHosts.add(host);
  for (const name of options.extraHostnames ?? []) {
    allowedHosts.add(`${name.includes(':') ? `[${name}]` : name}:${port}`.toLowerCase());
  }

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if ((client as AliveSocket).isAlive === false) {
        client.terminate();
        continue;
      }
      (client as AliveSocket).isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const urlHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  return {
    url: `${options.tls ? 'https' : 'http'}://${urlHost}:${port}`,
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type AliveSocket = WebSocket & { isAlive?: boolean };

const STREAM_PATH = /^\/v1\/sessions\/([^/]+)\/stream$/;

function handleUpgrade(
  ctx: AppContext,
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const refuse = (status: number, code: string) => {
    socket.end(`HTTP/1.1 ${status} ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  try {
    const failure = checkRequest(ctx.guards, req.headers.host, req.headers.origin);
    if (failure) throw new HttpError(403, failure, 'request rejected');
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const match = STREAM_PATH.exec(url.pathname);
    if (!match?.[1]) throw new HttpError(404, 'NOT_FOUND', 'no such endpoint');
    const session = sessionFor(ctx, match[1]);
    // Browsers cannot set Authorization on WebSockets, so the token travels as a subprotocol.
    const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    const token = offered.find((p) => p.startsWith(WS_AUTH_PREFIX))?.slice(WS_AUTH_PREFIX.length);
    const auth = resolveBearer(ctx, token, session);
    const after = Number(url.searchParams.get('after') ?? '0');
    if (!Number.isInteger(after) || after < 0) {
      throw new HttpError(400, 'INVALID_REQUEST', 'invalid after');
    }
    wss.handleUpgrade(req, socket, head, (ws) => streamSession(ws, session, auth, after));
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    refuse(status, body.error.code);
  }
}

function streamSession(
  ws: AliveSocket,
  session: HostSession,
  auth: ReturnType<typeof resolveBearer>,
  after: number,
): void {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  let lastSent = after;
  const send = (event: SequencedEvent) => {
    if (event.sequence <= lastSent) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Slow consumer: drop the connection; it resumes from its cursor (threat model T07).
      ws.close(1013, 'too slow');
      return;
    }
    lastSent = event.sequence;
    ws.send(JSON.stringify({ type: 'event', event }));
  };

  // Subscribe before sending the backlog so nothing appended meanwhile is missed; `send`
  // skips anything already delivered.
  const unsubscribe = session.log.subscribe(send);
  for (let batch = session.log.after(lastSent, 500); batch.length > 0; ) {
    for (const event of batch) send(event);
    batch = session.log.after(lastSent, 500);
  }
  ws.send(JSON.stringify({ type: 'ready', head: session.log.head }));

  const expiry = setTimeout(() => ws.close(4001, 'token expired'), auth.expiresAt - Date.now());
  expiry.unref();

  ws.on('message', (data, isBinary) => {
    let requestId: unknown;
    try {
      const message = parseMessage(data.toString(), isBinary);
      requestId = message.id;
      assertActor(message.event, auth);
      const result = session.log.append(message.event);
      ws.send(
        JSON.stringify({
          type: 'ack',
          id: requestId,
          status: result.status,
          sequence: result.event.sequence,
        }),
      );
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      ws.send(
        JSON.stringify({
          type: 'error',
          id: requestId,
          code: body.error.code,
          status,
          message: body.error.message,
        }),
      );
    }
  });

  ws.on('close', () => {
    unsubscribe();
    clearTimeout(expiry);
  });
}

function parseMessage(text: string, isBinary: boolean): { id?: unknown; event: unknown } {
  const invalid = () => new HttpError(400, 'INVALID_MESSAGE', 'expected a JSON append message');
  if (isBinary) throw invalid();
  let message: { type?: unknown; id?: unknown; event?: unknown };
  try {
    message = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (message?.type !== 'append') throw invalid();
  return message as { id?: unknown; event: unknown };
}
