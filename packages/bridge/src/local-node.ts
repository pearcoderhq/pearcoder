import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { ClientError, renderReviewMarkdown } from '@pearcoderhq/client';
import { type DeviceIdentity, readProfile, redactValue, scanValue } from '@pearcoderhq/core';
import {
  AgentHarnessSchema,
  EVENT_PAYLOAD_SCHEMAS,
  type SessionId,
  WS_AUTH_PREFIX,
} from '@pearcoderhq/protocol';
import { checkRequest, type GuardConfig, loopbackHosts } from '@pearcoderhq/server';
import { webAssetsDir } from '@pearcoderhq/web';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { DraftError, discardDraft, getDraft, listDrafts, updateDraft } from './drafts.js';
import { SessionHub } from './hub.js';
import { notify } from './notify.js';
import { PublishBlockedError, publishDraft } from './publish.js';

export const LOCAL_WS_PROTOCOL = 'pearcoder.local.v1';
const REFRESH_MS = 10_000;

export interface LocalNodeOptions {
  home: string;
  identity: DeviceIdentity;
  port?: number;
  /** Built web UI; defaults to the `@pearcoderhq/web` build. */
  assetsDir?: string;
  /** Show an OS notification when someone asks this owner for something (opt-in). */
  notifications?: boolean;
}

export interface RunningLocalNode {
  /** Plain UI address. */
  url: string;
  /** Address to open in the browser: carries the owner token in the fragment. */
  openUrl: string;
  port: number;
  hub: SessionHub;
  close(): Promise<void>;
}

class LocalHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const SayBody = z.object({ text: z.string().trim().min(1).max(16_000) });
const RequestBody = z.object({
  to: z.array(z.string()).min(1).max(20),
  kind: z.enum(['review', 'question', 'discussion']),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(16_000).optional(),
  context_package: z.string().optional(),
  for_agent: AgentHarnessSchema.optional(),
});
const ResolveBody = z.object({
  resolution: z.enum(['accepted', 'declined', 'done']),
  note: z.string().max(2_000).optional(),
});
const UI_EVENT_TYPES = [
  'message.created',
  'request.created',
  'request.resolved',
  'finding.resolved',
  'decision.proposed',
  'decision.vote',
  'decision.resolved',
] as const;
const UiEventBody = z.object({
  type: z.enum(UI_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
  reply_to: z.uuid().optional(),
});
const PublishBody = z.object({ mode: z.enum(['as_is', 'redact', 'allow']).default('as_is') });

/**
 * The owner's local node: loopback-only HTTP and WebSocket for the browser UI, guarded by an
 * owner token that exists only in this process and the opened URL's fragment (threat model T16).
 * Fragments are never sent to servers or in Referer headers.
 */
export async function startLocalNode(options: LocalNodeOptions): Promise<RunningLocalNode> {
  const token = randomBytes(32).toString('base64url');
  const hub = new SessionHub(options.home, options.identity);
  const assetsDir = options.assetsDir ?? webAssetsDir;
  const allowedHosts = new Set<string>();
  const allowedOrigins = new Set<string>();
  const guards: GuardConfig = { allowedHosts, allowedOrigins };
  let port = 0;

  const isOwner = (presented: string | undefined) => {
    if (!presented) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const app = new Hono();
  const draftOr404 = (id: string) => {
    try {
      return getDraft(options.home, id);
    } catch {
      throw new LocalHttpError(404, 'DRAFT_NOT_FOUND', 'no such draft');
    }
  };

  app.onError((error, c) => {
    if (error instanceof DraftError) {
      return c.json({ error: { code: error.code, message: error.message } }, 400);
    }
    if (error instanceof LocalHttpError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    if (error instanceof ClientError) {
      const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
      return c.json({ error: { code: error.code, message: error.message } }, status as 400);
    }
    return c.json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
  });

  app.use('*', async (c, next) => {
    const failure = checkRequest(guards, c.req.header('host'), c.req.header('origin'));
    if (failure) throw new LocalHttpError(403, failure, 'request rejected');
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header(
      'Content-Security-Policy',
      `default-src 'self'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
  });

  app.use('/api/*', bodyLimit({ maxSize: 64 * 1024 }));
  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization');
    if (!isOwner(header?.startsWith('Bearer ') ? header.slice(7) : undefined)) {
      throw new LocalHttpError(401, 'UNAUTHORIZED', 'owner token required');
    }
    await next();
  });

  app.get('/api/me', (c) =>
    c.json({
      user_id: options.identity.userId,
      display_name: readProfile(options.home)?.display_name ?? null,
    }),
  );

  app.get('/api/sessions', async (c) => {
    await hub.refresh();
    return c.json({ sessions: hub.sessions() });
  });

  app.get('/api/sessions/:id/events', (c) => {
    const events = hub.events(c.req.param('id') as SessionId);
    if (!events) throw new LocalHttpError(404, 'SESSION_NOT_FOUND', 'unknown session');
    return c.json({ events });
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new LocalHttpError(400, 'INVALID_JSON', 'body is not valid JSON');
    }
    const parsed = SayBody.safeParse(body);
    if (!parsed.success) throw new LocalHttpError(400, 'INVALID_REQUEST', 'text is required');
    const outcome = await hub.say(c.req.param('id') as SessionId, parsed.data.text);
    if (!outcome) throw new LocalHttpError(409, 'NOT_CONNECTED', 'session is not connected');
    return c.json(outcome);
  });

  const readJson = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      throw new LocalHttpError(400, 'INVALID_JSON', 'body is not valid JSON');
    }
  };
  const appendOrFail = async (
    sessionId: string,
    event: { type: string; payload: Record<string, unknown> },
  ) => {
    const outcome = await hub.append(sessionId as SessionId, event);
    if (!outcome) throw new LocalHttpError(409, 'NOT_CONNECTED', 'session is not connected');
    return outcome;
  };

  app.post('/api/sessions/:id/requests', async (c) => {
    const parsed = RequestBody.safeParse(await readJson(c));
    if (!parsed.success) throw new LocalHttpError(400, 'INVALID_REQUEST', 'invalid request');
    return c.json(
      await appendOrFail(c.req.param('id'), { type: 'request.created', payload: parsed.data }),
    );
  });

  app.post('/api/sessions/:id/requests/:request/resolve', async (c) => {
    const parsed = ResolveBody.safeParse(await readJson(c));
    if (!parsed.success) throw new LocalHttpError(400, 'INVALID_REQUEST', 'invalid resolution');
    return c.json(
      await appendOrFail(c.req.param('id'), {
        type: 'request.resolved',
        payload: { request: c.req.param('request'), ...parsed.data },
      }),
    );
  });

  // Events the owner creates by clicking in the UI. The host still checks roles and references;
  // this list keeps the local API intentional (no participant or presence spoofing from the UI).
  app.post('/api/sessions/:id/events', async (c) => {
    const parsed = UiEventBody.safeParse(await readJson(c));
    if (!parsed.success) throw new LocalHttpError(400, 'INVALID_REQUEST', 'unsupported event');
    const schema = EVENT_PAYLOAD_SCHEMAS[parsed.data.type];
    if (!schema.safeParse(parsed.data.payload).success) {
      throw new LocalHttpError(400, 'INVALID_PAYLOAD', `invalid ${parsed.data.type} payload`);
    }
    return c.json(
      await appendOrFail(c.req.param('id'), {
        type: parsed.data.type,
        payload: parsed.data.payload,
        ...(parsed.data.reply_to && { reply_to: parsed.data.reply_to }),
      }),
    );
  });

  app.get('/api/sessions/:id/export.md', (c) => {
    const sessionId = c.req.param('id') as SessionId;
    const events = hub.events(sessionId);
    const view = hub.sessions().find((s) => s.session_id === sessionId);
    if (!events || !view) throw new LocalHttpError(404, 'SESSION_NOT_FOUND', 'unknown session');
    const name = view.session_name.replace(/[^A-Za-z0-9._-]+/g, '-');
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="pearcoder-${name}.md"`);
    return c.body(renderReviewMarkdown(events, { sessionName: view.session_name }));
  });

  // Drafts are written by the owner's agent through MCP (another process) and published only here
  // or with `pearcoder publish`, after the owner looked at them (docs/invariants.md, invariant 3).
  app.get('/api/drafts', (c) => c.json({ drafts: listDrafts(options.home) }));

  app.get('/api/drafts/:id', (c) => {
    const draft = draftOr404(c.req.param('id'));
    const findings = scanValue(draft.payload);
    return c.json({
      draft,
      findings,
      redacted: findings.length ? redactValue(draft.payload) : null,
    });
  });

  app.put('/api/drafts/:id', async (c) => {
    const draft = draftOr404(c.req.param('id'));
    return c.json({ draft: updateDraft(options.home, draft.id, await readJson(c)) });
  });

  app.post('/api/drafts/:id/publish', async (c) => {
    const draft = draftOr404(c.req.param('id'));
    const parsed = PublishBody.safeParse(await readJson(c));
    if (!parsed.success) throw new LocalHttpError(400, 'INVALID_REQUEST', 'invalid publish mode');
    try {
      const result = await publishDraft(options.home, options.identity, draft.id, {
        redact: parsed.data.mode === 'redact',
        allowSecrets: parsed.data.mode === 'allow',
      });
      return c.json({ event_id: result.eventId, sequence: result.sequence });
    } catch (error) {
      if (error instanceof PublishBlockedError) {
        return c.json(
          { error: { code: error.code, message: error.message }, findings: error.findings },
          422,
        );
      }
      throw error;
    }
  });

  app.post('/api/drafts/:id/discard', (c) => {
    const draft = draftOr404(c.req.param('id'));
    return c.json({ draft: discardDraft(options.home, draft.id) });
  });

  app.all('/api/*', () => {
    throw new LocalHttpError(404, 'NOT_FOUND', 'no such endpoint');
  });

  const built = existsSync(join(assetsDir, 'index.html'));
  app.get(
    '*',
    built
      ? serveStatic({ root: assetsDir })
      : (c: Context) =>
          c.text('Web UI not built yet: run `pnpm --filter @pearcoderhq/web build`.', 503),
  );
  app.get('*', serveStatic({ root: assetsDir, path: 'index.html' }));

  const server = createServer(getRequestListener(app.fetch));
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024,
    handleProtocols: (protocols) => (protocols.has(LOCAL_WS_PROTOCOL) ? LOCAL_WS_PROTOCOL : false),
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const refuse = (status: number, code: string) =>
      socket.end(`HTTP/1.1 ${status} ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const failure = checkRequest(guards, req.headers.host, req.headers.origin);
    if (failure) return void refuse(403, failure);
    if (new URL(req.url ?? '/', 'http://local').pathname !== '/api/stream') {
      return void refuse(404, 'NOT_FOUND');
    }
    const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    const presented = offered
      .find((p) => p.startsWith(WS_AUTH_PREFIX))
      ?.slice(WS_AUTH_PREFIX.length);
    if (!isOwner(presented)) return void refuse(401, 'UNAUTHORIZED');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const unsubscribe = hub.subscribe((update) => ws.send(JSON.stringify(update)));
      ws.on('close', unsubscribe);
      // The browser only listens; anything it sends is ignored.
      ws.on('message', () => undefined);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  for (const host of loopbackHosts(port)) allowedHosts.add(host);
  allowedOrigins.add(`http://127.0.0.1:${port}`);
  allowedOrigins.add(`http://localhost:${port}`);

  const stopNotifications = options.notifications
    ? hub.onRequestForMe((sessionName, event) => {
        const names = new Map(
          (hub.events(event.session_id) ?? [])
            .filter((e) => e.type === 'participant.joined')
            .map((e) => [e.actor_user_id, String(e.payload.display_name)]),
        );
        notify(
          `Pearcoder · ${sessionName}`,
          event.type === 'message.created'
            ? `${names.get(event.actor_user_id) ?? 'Someone'} mentioned you: ${String(event.payload.text)}`
            : `${names.get(event.actor_user_id) ?? 'Someone'} asks: ${String(event.payload.title)}`,
        );
      })
    : () => undefined;

  const refresher = setInterval(() => void hub.refresh(), REFRESH_MS);
  refresher.unref();
  await hub.refresh();

  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    openUrl: `${url}/#token=${token}`,
    port,
    hub,
    close: async () => {
      stopNotifications();
      clearInterval(refresher);
      await hub.close();
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
