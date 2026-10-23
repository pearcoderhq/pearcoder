// Covers: T16 (local node), T06 through the UI path
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { joinSession, writeRecord } from '@pearcoderhq/client';
import {
  HostSession,
  loadOrCreateDeviceIdentity,
  recordAttachedAgent,
  writeProfile,
} from '@pearcoderhq/core';
import type { SessionId } from '@pearcoderhq/protocol';
import { type RunningSessionServer, startSessionServer } from '@pearcoderhq/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SessionHub } from '../src/hub.js';
import { LOCAL_WS_PROTOCOL, type RunningLocalNode, startLocalNode } from '../src/local-node.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pearcoder-node-'));
  dirs.push(d);
  return d;
};

const hostHome = temp();
const hostIdentity = loadOrCreateDeviceIdentity(hostHome);
const session = HostSession.create({
  identity: hostIdentity,
  displayName: 'Hana',
  sessionName: 'auth-review',
});
let server: RunningSessionServer;
let node: RunningLocalNode;
let token: string;
const assets = temp();
writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Pearcoder</title>');

beforeAll(async () => {
  server = await startSessionServer({
    sessions: new Map<SessionId, HostSession>([[session.sessionId, session]]),
  });
  session.setInviteDefaults({ addresses: [server.url] });
  writeProfile({ display_name: 'Hana' }, hostHome);
  recordAttachedAgent('claude-code', hostHome);
  writeRecord(hostHome, {
    v: 1,
    session_id: session.sessionId,
    session_name: session.sessionName,
    host_user_id: hostIdentity.userId,
    host_public_key: hostIdentity.publicKey,
    role: 'host',
    addresses: [server.url],
    joined_at: new Date().toISOString(),
  });
  node = await startLocalNode({ home: hostHome, identity: hostIdentity, assetsDir: assets });
  token = new URL(node.openUrl).hash.replace('#token=', '');
});

afterAll(async () => {
  await node.close();
  await server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown; auth?: boolean; base?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${options.base ?? node.url}${path}`,
      {
        method,
        headers: {
          ...(options.auth === false ? {} : { authorization: `Bearer ${token}` }),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await delay(25);
  }
}

describe('local node', () => {
  it('listens on loopback only and hands out the token in the URL fragment', () => {
    expect(node.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(node.openUrl).toMatch(/\/#token=[A-Za-z0-9_-]{43}$/);
  });

  it('serves the UI with strict security headers and no token needed', async () => {
    const res = await call('GET', '/', { auth: false });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<title>Pearcoder</title>');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('requires the owner token for every API call', async () => {
    expect((await call('GET', '/api/me', { auth: false })).status).toBe(401);
    expect(
      (await call('GET', '/api/me', { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    const me = await call('GET', '/api/me');
    expect(JSON.parse(me.body)).toEqual({ user_id: hostIdentity.userId, display_name: 'Hana' });
  });

  it('rejects other origins and foreign Host headers even with the token (CSRF, DNS rebinding)', async () => {
    const evil = await call('POST', `/api/sessions/${session.sessionId}/messages`, {
      headers: { origin: 'https://evil.example' },
      body: { text: 'csrf' },
    });
    expect(evil.status).toBe(403);
    expect(JSON.parse(evil.body).error.code).toBe('ORIGIN_NOT_ALLOWED');
    const rebound = await call('GET', '/api/me', {
      headers: { host: `evil.example:${node.port}` },
    });
    expect(JSON.parse(rebound.body).error.code).toBe('HOST_NOT_ALLOWED');
    expect(session.log.after(0).some((e) => e.payload.text === 'csrf')).toBe(false);
  });

  it('lists sessions, relays messages to the host, and announces presence', async () => {
    await until(async () => {
      const { sessions } = JSON.parse((await call('GET', '/api/sessions')).body);
      return sessions[0]?.status === 'online';
    });
    const sent = await call('POST', `/api/sessions/${session.sessionId}/messages`, {
      headers: { origin: node.url },
      body: { text: 'from the browser' },
    });
    expect(sent.status).toBe(200);
    expect(session.log.after(0).some((e) => e.payload.text === 'from the browser')).toBe(true);
    await until(() =>
      session.log
        .after(0)
        .some((e) => e.type === 'presence.changed' && e.actor_user_id === hostIdentity.userId),
    );
    // The announcement says which agents are attached, so others can address requests to them.
    const presence = session.log
      .after(0)
      .find((e) => e.type === 'presence.changed' && e.actor_user_id === hostIdentity.userId);
    expect(presence?.payload).toEqual({ state: 'online', agents: ['claude-code'] });

    // Attaching another agent later is announced on the next refresh, without a restart.
    const hub = new SessionHub(hostHome, hostIdentity);
    try {
      await hub.refresh();
      await until(() => hub.sessions()[0]?.status === 'online');
      recordAttachedAgent('codex', hostHome);
      await hub.refresh();
      await until(() =>
        session.log
          .after(0)
          .some(
            (e) =>
              e.type === 'presence.changed' &&
              JSON.stringify(e.payload.agents) === JSON.stringify(['claude-code', 'codex']),
          ),
      );
    } finally {
      await hub.close();
    }
    const events = JSON.parse(
      (await call('GET', `/api/sessions/${session.sessionId}/events`)).body,
    ).events;
    expect(events.map((e: { type: string }) => e.type)).toContain('message.created');
  });

  it('streams live updates over an authenticated, same-origin WebSocket only', async () => {
    const wsUrl = `${node.url.replace('http', 'ws')}/api/stream`;
    const refused = (protocols: string[], origin?: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(wsUrl, protocols, origin ? { origin } : {});
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => resolve(101));
      });
    expect(await refused([LOCAL_WS_PROTOCOL])).toBe(401);
    expect(
      await refused([LOCAL_WS_PROTOCOL, `pearcoder.auth.${token}`], 'https://evil.example'),
    ).toBe(403);

    const updates: { type: string; event?: { payload: { text?: string } } }[] = [];
    const ws = new WebSocket(wsUrl, [LOCAL_WS_PROTOCOL, `pearcoder.auth.${token}`], {
      origin: node.url,
    });
    ws.on('message', (data) => updates.push(JSON.parse(data.toString())));
    await new Promise((resolve) => ws.once('open', resolve));

    // A teammate joins with the CLI flow and posts; the browser sees it live.
    const guestHome = temp();
    const guest = loadOrCreateDeviceIdentity(guestHome);
    const { token: inviteToken } = session.invite({ addresses: [server.url] });
    const joined = await joinSession(inviteToken, guest, 'Alice');
    const { SessionClient } = await import('@pearcoderhq/client');
    const alice = new SessionClient({
      host: joined.host,
      endpoint: joined.endpoint,
      identity: guest,
    });
    await alice.say('live from alice');
    await until(() => updates.some((u) => u.event?.payload.text === 'live from alice'));
    ws.close();
  });

  it('forwards host rejections, e.g. an observer posting', async () => {
    const watcherHome = temp();
    const watcher = loadOrCreateDeviceIdentity(watcherHome);
    const { token: inviteToken } = session.invite({ addresses: [server.url], role: 'observer' });
    const joined = await joinSession(inviteToken, watcher, 'Wanda');
    writeRecord(watcherHome, {
      v: 1,
      session_id: joined.host.session_id,
      session_name: joined.host.session_name,
      host_user_id: joined.host.host_user_id,
      host_public_key: joined.host.host_public_key,
      role: 'observer',
      addresses: joined.host.addresses,
      joined_at: new Date().toISOString(),
    });
    const watcherNode = await startLocalNode({
      home: watcherHome,
      identity: watcher,
      assetsDir: assets,
    });
    try {
      const watcherToken = new URL(watcherNode.openUrl).hash.replace('#token=', '');
      await until(async () => {
        const res = await call('GET', '/api/sessions', {
          base: watcherNode.url,
          headers: { authorization: `Bearer ${watcherToken}` },
        });
        return JSON.parse(res.body).sessions[0]?.status === 'online';
      });
      const res = await call('POST', `/api/sessions/${session.sessionId}/messages`, {
        base: watcherNode.url,
        headers: { authorization: `Bearer ${watcherToken}` },
        body: { text: 'observer speaking' },
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN_FOR_ROLE');
    } finally {
      await watcherNode.close();
    }
  });
});

describe('review workflow through the local node', () => {
  it('creates and resolves requests only as the owner, through the UI path', async () => {
    const guestHome = temp();
    const guest = loadOrCreateDeviceIdentity(guestHome);
    const { token: inviteToken } = session.invite({ addresses: [server.url] });
    await joinSession(inviteToken, guest, 'Reviewer');
    const created = await call('POST', `/api/sessions/${session.sessionId}/requests`, {
      headers: { origin: node.url },
      body: { to: [guest.userId], kind: 'review', title: 'Look at token rotation' },
    });
    expect(created.status).toBe(200);
    const { id } = JSON.parse(created.body) as { id: string };
    expect(session.log.get(id)).toMatchObject({
      type: 'request.created',
      actor_user_id: hostIdentity.userId,
    });

    const resolved = await call(
      'POST',
      `/api/sessions/${session.sessionId}/requests/${id}/resolve`,
      {
        body: { resolution: 'done' },
      },
    );
    expect(resolved.status).toBe(200);
    const bad = await call('POST', `/api/sessions/${session.sessionId}/requests`, {
      body: { to: [], kind: 'review', title: 'x' },
    });
    expect(bad.status).toBe(400);
  });

  it('lists, scans, edits, publishes and discards drafts; secrets need redaction', async () => {
    const { createDraft } = await import('../src/drafts.js');
    const clean = createDraft(hostHome, {
      sessionId: session.sessionId,
      source: { via: 'mcp', harness: 'claude-code' },
      payload: { title: 'Race in rotate()', severity: 'high', body: 'check-then-act' },
    });
    const leaky = createDraft(hostHome, {
      sessionId: session.sessionId,
      source: { via: 'mcp', harness: 'claude-code' },
      payload: { title: 'Leak', severity: 'low', body: `token ghp_${'z'.repeat(36)}` },
    });
    const listed = JSON.parse((await call('GET', '/api/drafts')).body).drafts as { id: string }[];
    expect(listed.map((d) => d.id)).toEqual(expect.arrayContaining([clean.id, leaky.id]));

    const scan = JSON.parse((await call('GET', `/api/drafts/${leaky.id}`)).body);
    expect(scan.findings[0].kind).toBe('github_token');
    expect(scan.redacted.body).toBe('token [redacted github token]');

    const blocked = await call('POST', `/api/drafts/${leaky.id}/publish`, {
      body: { mode: 'as_is' },
    });
    expect(blocked.status).toBe(422);
    expect(JSON.parse(blocked.body).error.code).toBe('SECRETS_FOUND');

    const edited = await call('PUT', `/api/drafts/${clean.id}`, {
      body: { title: 'Race in rotate() (edited)', severity: 'high', body: 'check-then-act' },
    });
    expect(edited.status).toBe(200);
    const published = await call('POST', `/api/drafts/${clean.id}/publish`, { body: {} });
    expect(published.status).toBe(200);
    const { event_id } = JSON.parse(published.body) as { event_id: string };
    expect(session.log.get(event_id)).toMatchObject({
      type: 'review.finding',
      payload: { title: 'Race in rotate() (edited)' },
      actor_agent_id: expect.stringMatching(/^a_/),
    });
    const again = await call('POST', `/api/drafts/${clean.id}/publish`, { body: {} });
    expect(JSON.parse(again.body).error.code).toBe('DRAFT_NOT_EDITABLE');

    const discarded = await call('POST', `/api/drafts/${leaky.id}/discard`, { body: {} });
    expect(JSON.parse(discarded.body).draft.status).toBe('discarded');
    expect((await call('GET', '/api/drafts/nope')).status).toBe(404);
  });

  it('requires the owner token for drafts too', async () => {
    expect((await call('GET', '/api/drafts', { auth: false })).status).toBe(401);
  });
});

describe('UI events and export', () => {
  it('accepts only the UI event types, validates payloads, and exports Markdown', async () => {
    const proposed = await call('POST', `/api/sessions/${session.sessionId}/events`, {
      body: {
        type: 'decision.proposed',
        payload: { title: 'Use CAS', decision: 'Conditional UPDATE' },
      },
    });
    expect(proposed.status).toBe(200);
    const { id } = JSON.parse(proposed.body) as { id: string };
    expect(
      (
        await call('POST', `/api/sessions/${session.sessionId}/events`, {
          body: { type: 'decision.resolved', payload: { decision: id, outcome: 'accepted' } },
        })
      ).status,
    ).toBe(200);
    for (const type of [
      'participant.joined',
      'presence.changed',
      'context_package.published',
      'local_execution.authorized',
    ]) {
      const res = await call('POST', `/api/sessions/${session.sessionId}/events`, {
        body: { type, payload: {} },
      });
      expect(res.status, type).toBe(400);
    }
    const bad = await call('POST', `/api/sessions/${session.sessionId}/events`, {
      body: { type: 'decision.vote', payload: { decision: id, stance: 'maybe' } },
    });
    expect(JSON.parse(bad.body).error.code).toBe('INVALID_PAYLOAD');

    await until(async () => {
      const md = await call('GET', `/api/sessions/${session.sessionId}/export.md`);
      return md.body.includes('### Use CAS (accepted by Hana)');
    });
    const md = await call('GET', `/api/sessions/${session.sessionId}/export.md`);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.headers['content-disposition']).toContain('pearcoder-auth-review.md');
    expect(
      (await call('GET', `/api/sessions/${session.sessionId}/export.md`, { auth: false })).status,
    ).toBe(401);
  });
});
