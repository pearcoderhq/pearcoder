import { homedir } from 'node:os';
import { dirname, join as joinPath } from 'node:path';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import {
  discardDraft,
  draftTitle,
  getDraft,
  listDrafts,
  PublishBlockedError,
  publishDraft,
  startLocalNode,
} from '@pearcoderhq/bridge';
import {
  buildContextPackage,
  buildPullRequestPackage,
  type ClientError,
  decisionsOf,
  type ExcerptSpec,
  findingsOf,
  findParticipants,
  inboxOf,
  joinSession,
  listRecords,
  MemoryCursorStore,
  mentionsOf,
  messageWithMentions,
  packagesOf,
  planGithubReview,
  postGithubReview,
  removeRecord,
  renderJsonl,
  renderReviewMarkdown,
  requestJson,
  requestsOf,
  resolveEndpoint,
  SessionClient,
  type SessionRecord,
  verifyExport,
  writeRecord,
} from '@pearcoderhq/client';
import {
  type DeviceIdentity,
  HostSession,
  listHostedSessions,
  loadOrCreateDeviceIdentity,
  lockHostedSession,
  openSessionStore,
  readProfile,
  recordAttachedAgent,
  redactValue,
  SessionBusyError,
  type SqliteSessionStore,
  writeProfile,
} from '@pearcoderhq/core';
import { runStdioServer } from '@pearcoderhq/mcp';
import {
  type AgentHarness,
  newSessionId,
  type SequencedEvent,
  type SessionId,
  withContextPackageHash,
} from '@pearcoderhq/protocol';
import {
  lanAddresses,
  loadOrCreateTls,
  loadProvidedTls,
  startSessionServer,
  type TlsMaterial,
} from '@pearcoderhq/server';
import {
  claudeAttachCommands,
  codexAttachPlan,
  marketplaceDir,
  pluginShipped,
  runClaude,
} from './attach.js';
import { matching } from './ids.js';
import { homeOf, type Io, UsageError, waitForAbort } from './io.js';
import { openBrowser } from './open.js';
import { cliEntry, codexIntegrationDir } from './paths.js';
import { selectRecord } from './records.js';

export const DEFAULT_PORT = 47321;

function args<T extends NonNullable<ParseArgsConfig['options']>>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function displayName(home: string, flag: string | undefined): string {
  const name = flag ?? readProfile(home)?.display_name;
  if (!name)
    throw new UsageError(
      'set your name once with `pearcoder whoami --set-name <name>` or pass --as <name>',
    );
  return name;
}

/** `--as` becomes the default name, but only once the command it came with has worked. */
function rememberName(home: string, flag: string | undefined): void {
  if (flag) writeProfile({ display_name: flag }, home);
}

function secretFlags(values: { redact: boolean; 'allow-secrets': boolean }): void {
  if (values.redact && values['allow-secrets']) {
    throw new UsageError('use --redact or --allow-secrets, not both');
  }
}

function parseDuration(value: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match) throw new UsageError(`invalid duration ${value}; use e.g. 30m, 24h or 7d`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'];
  return Number(match[1]) * unit;
}

async function connect(record: SessionRecord, identity: DeviceIdentity): Promise<SessionClient> {
  const endpoint = await resolveEndpoint(record);
  return new SessionClient({ host: record, endpoint, identity });
}

// ---------------------------------------------------------------------------------------------

const HOST_OPTIONS = {
  name: { type: 'string' },
  as: { type: 'string' },
  lan: { type: 'boolean', default: false },
  port: { type: 'string' },
  role: { type: 'string', default: 'member' },
  'tls-cert': { type: 'string' },
  'tls-key': { type: 'string' },
  'no-ui': { type: 'boolean', default: false },
  'no-open': { type: 'boolean', default: false },
  notify: { type: 'boolean', default: false },
  persist: { type: 'boolean', default: false },
  resume: { type: 'string' },
  json: { type: 'boolean', default: false },
} as const;
type HostValues = ReturnType<typeof args<typeof HOST_OPTIONS>>['values'];

export async function host(argv: string[], io: Io): Promise<number> {
  const { values } = args(argv, HOST_OPTIONS);
  if (!values.name && !values.resume) {
    throw new UsageError(
      'pearcoder host --name <session name> [--persist], or pearcoder host --resume <name|id>',
    );
  }
  if (values.role !== 'member' && values.role !== 'observer') {
    throw new UsageError('--role must be member or observer');
  }
  if (Boolean(values['tls-cert']) !== Boolean(values['tls-key'])) {
    throw new UsageError('--tls-cert and --tls-key go together');
  }
  const home = homeOf(io);
  const identity = loadOrCreateDeviceIdentity(home);
  const name = displayName(home, values.as);
  // Persistent sessions keep their history, participants and invitations in SQLite (M3.5).
  let store: SqliteSessionStore | undefined;
  let sessionId: SessionId | undefined;
  let sessionName = values.name;
  if (values.resume) {
    const wanted = values.resume.toLowerCase();
    const matches = listHostedSessions(home).filter(
      (h) => h.sessionId === values.resume || h.sessionName.toLowerCase() === wanted,
    );
    if (matches.length !== 1 || !matches[0]) {
      throw new UsageError(
        matches.length
          ? `several hosted sessions are named ${values.resume}; use the id`
          : `no persisted session ${values.resume}`,
      );
    }
    sessionId = matches[0].sessionId;
    store = openSessionStore(home, sessionId);
    sessionName = store.getMeta('session_name') ?? matches[0].sessionName;
  } else if (values.persist) {
    const wanted = (values.name as string).toLowerCase();
    if (listHostedSessions(home).some((h) => h.sessionName.toLowerCase() === wanted)) {
      throw new UsageError(
        `you already host a persisted session named ${values.name}; continue it with: pearcoder host --resume "${values.name}"`,
      );
    }
    sessionId = newSessionId();
    store = openSessionStore(home, sessionId);
    store.setMeta('session_name', values.name as string);
  }
  // One process per persisted history: a second host would fork the log.
  let release: (() => void) | undefined;
  if (store && sessionId) {
    try {
      release = lockHostedSession(home, sessionId);
    } catch (error) {
      store.close();
      if (error instanceof SessionBusyError) {
        throw new UsageError(
          `"${sessionName}" is already being hosted on this device (process ${error.pid})`,
        );
      }
      throw error;
    }
  }
  try {
    return await hostSession(
      io,
      home,
      identity,
      name,
      values,
      store,
      sessionId,
      sessionName as string,
    );
  } finally {
    store?.close();
    release?.();
  }
}

async function hostSession(
  io: Io,
  home: string,
  identity: DeviceIdentity,
  name: string,
  values: HostValues,
  store: SqliteSessionStore | undefined,
  sessionId: SessionId | undefined,
  sessionName: string,
): Promise<number> {
  // Reusing the port keeps outstanding invitations pointing at the right address.
  const savedPort = store?.getMeta('port');
  const port =
    values.port !== undefined ? Number(values.port) : savedPort ? Number(savedPort) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('invalid --port');

  const session = HostSession.create({
    identity,
    displayName: name,
    sessionName,
    ...(sessionId && { sessionId }),
    ...(store && { store, invitationPersistence: store }),
  });
  let tls: TlsMaterial | undefined;
  if (values['tls-cert'] && values['tls-key']) {
    tls = loadProvidedTls(values['tls-cert'], values['tls-key']);
  } else if (values.lan) {
    tls = await loadOrCreateTls(home, { hosts: ['127.0.0.1', 'localhost', ...lanAddresses()] });
  }
  if (values.lan && !tls) throw new UsageError('LAN hosting requires TLS');

  const lanIps = values.lan ? lanAddresses() : [];
  if (values.lan && lanIps.length === 0)
    throw new UsageError('no LAN address found on this machine');
  const server = await startSessionServer({
    sessions: new Map<SessionId, HostSession>([[session.sessionId, session]]),
    hostname: values.lan ? '0.0.0.0' : '127.0.0.1',
    port,
    extraHostnames: lanIps,
    ...(tls ? { tls } : {}),
  });
  store?.setMeta('port', String(server.port));
  const scheme = tls ? 'https' : 'http';
  const loopback = `${scheme}://127.0.0.1:${server.port}`;
  const addresses = values.lan
    ? lanIps.map((ip) => `${scheme}://${ip}:${server.port}`)
    : [loopback];
  rememberName(home, values.as);
  return await serveHost(io, home, identity, session, server, tls, loopback, addresses, {
    ...values,
    persisted: Boolean(store),
  });
}

async function serveHost(
  io: Io,
  home: string,
  identity: DeviceIdentity,
  session: HostSession,
  server: Awaited<ReturnType<typeof startSessionServer>>,
  tls: TlsMaterial | undefined,
  loopback: string,
  addresses: string[],
  values: {
    json: boolean;
    role: string;
    name?: string;
    'no-ui': boolean;
    'no-open': boolean;
    notify: boolean;
    persisted?: boolean;
  },
): Promise<number> {
  session.setInviteDefaults({
    addresses,
    ...(tls && { tlsFingerprint: tls.fingerprint }),
  });
  writeRecord(home, {
    v: 1,
    session_id: session.sessionId,
    session_name: session.sessionName,
    host_user_id: identity.userId,
    host_public_key: identity.publicKey,
    role: 'host',
    addresses: [loopback],
    ...(tls && { tls_fingerprint: tls.fingerprint }),
    joined_at: new Date().toISOString(),
  });
  const { token } = session.invite({
    addresses,
    ...(tls && { tlsFingerprint: tls.fingerprint }),
    role: values.role as 'member' | 'observer',
  });

  // The host is also a participant: its own local node serves the web UI.
  const node = values['no-ui']
    ? undefined
    : await startLocalNode({ home, identity, notifications: values.notify });

  if (values.json) {
    io.stdout(
      JSON.stringify({
        event: 'hosting',
        session_id: session.sessionId,
        session_name: session.sessionName,
        url: server.url,
        addresses,
        invite: token,
        ...(node && { ui_url: node.openUrl }),
      }),
    );
  } else {
    io.stdout(`Hosting "${session.sessionName}" (${session.sessionId}) on ${addresses.join(', ')}`);
    if (!tls) io.stdout('Local only: start with --lan to let teammates on your network join.');
    io.stdout('');
    io.stdout('Single-use invitation, valid 24h. Share it privately:');
    io.stdout(`  pearcoder join ${token}`);
    io.stdout('');
    if (node) io.stdout(`Web UI: ${node.openUrl}`);
    io.stdout('More invitations: `pearcoder invite`. Press Ctrl-C to stop hosting.');
  }

  const unsubscribe = session.log.subscribe((event) => {
    if (event.type !== 'participant.joined' && event.type !== 'participant.left') return;
    const who = session.log.participant(event.actor_user_id);
    if (values.json) {
      io.stdout(
        JSON.stringify({
          event: event.type,
          user_id: event.actor_user_id,
          display_name: who?.displayName,
        }),
      );
    } else {
      io.stdout(
        `${who?.displayName ?? event.actor_user_id} ${event.type === 'participant.joined' ? `joined as ${who?.role}` : 'left'}`,
      );
    }
  });
  if (node && io.isTTY && !values['no-open']) openBrowser(node.openUrl);
  await waitForAbort(io.signal);
  unsubscribe();
  await node?.close();
  await server.close();
  // A session that was not persisted is gone: forget it, so tools stop trying to reach it.
  if (!values.persisted) removeRecord(home, session.sessionId);
  if (!values.json) {
    io.stdout(
      values.persisted
        ? `Stopped hosting. Resume with: pearcoder host --resume "${session.sessionName}"`
        : 'Stopped hosting. The session is gone because it was not persisted (use --persist).',
    );
  }
  return 0;
}

export async function join(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = args(argv, {
    as: { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  const token = positionals[0];
  if (!token) throw new UsageError('pearcoder join <invitation>');
  const home = homeOf(io);
  const identity = loadOrCreateDeviceIdentity(home);
  const name = displayName(home, values.as);
  const joined = await joinSession(token, identity, name);
  rememberName(home, values.as);
  writeRecord(home, {
    v: 1,
    session_id: joined.host.session_id,
    session_name: joined.host.session_name,
    host_user_id: joined.host.host_user_id,
    host_public_key: joined.host.host_public_key,
    role: joined.host.role,
    addresses: joined.host.addresses,
    ...(joined.host.tls_fingerprint && { tls_fingerprint: joined.host.tls_fingerprint }),
    joined_at: new Date().toISOString(),
  });
  if (values.json) {
    io.stdout(
      JSON.stringify({
        session_id: joined.host.session_id,
        session_name: joined.host.session_name,
        role: joined.host.role,
      }),
    );
  } else {
    io.stdout(`Joined "${joined.host.session_name}" as ${joined.host.role}.`);
    io.stdout(
      joined.host.role === 'observer'
        ? 'Observers can read but not post. Follow it with `pearcoder watch` or `pearcoder ui`.'
        : 'Follow it with `pearcoder watch`, write with `pearcoder say <text>`.',
    );
  }
  return 0;
}

export async function invite(argv: string[], io: Io): Promise<number> {
  const { values } = args(argv, {
    session: { type: 'string' },
    role: { type: 'string', default: 'member' },
    expires: { type: 'string', default: '24h' },
    uses: { type: 'string', default: '1' },
    json: { type: 'boolean', default: false },
  });
  const home = homeOf(io);
  const record = selectRecord(home, values.session);
  if (record.role !== 'host') throw new UsageError('only the host can invite to this session');
  if (values.role !== 'member' && values.role !== 'observer') {
    throw new UsageError('--role must be member or observer');
  }
  const uses = Number(values.uses);
  if (!Number.isInteger(uses) || uses < 1 || uses > 100)
    throw new UsageError('--uses must be 1-100');
  const identity = loadOrCreateDeviceIdentity(home);
  const endpoint = await resolveEndpoint(record);
  const client = new SessionClient({ host: record, endpoint, identity });
  const token = await client.login();
  const issued = await requestJson<{ token: string; invitation: { expires_at: string } }>(
    endpoint,
    'POST',
    `/v1/sessions/${record.session_id}/invitations`,
    { token, body: { role: values.role, ttl_ms: parseDuration(values.expires), max_uses: uses } },
  );
  if (values.json) {
    io.stdout(
      JSON.stringify({
        invite: issued.token,
        expires_at: issued.invitation.expires_at,
        role: values.role,
        uses,
      }),
    );
  } else {
    io.stdout(
      `Invitation for "${record.session_name}" (${values.role}, ${uses} use${uses === 1 ? '' : 's'}, until ${new Date(issued.invitation.expires_at).toLocaleString()}):`,
    );
    io.stdout(`  pearcoder join ${issued.token}`);
  }
  return 0;
}

export async function say(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = args(argv, {
    session: { type: 'string' },
    reply: { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  const text = positionals.join(' ').trim();
  if (!text) throw new UsageError('pearcoder say <text>');
  const home = homeOf(io);
  const record = selectRecord(home, values.session);
  const client = await connect(record, loadOrCreateDeviceIdentity(home));
  // Only fetch history when the text could mention someone or answers an earlier event.
  const history = text.includes('@') || values.reply ? await client.history() : [];
  const payload = text.includes('@') ? messageWithMentions(history, text) : { text };
  const replyTo = values.reply ? expandId(history, values.reply) : undefined;
  const outcome = await client.append({
    type: 'message.created',
    payload,
    ...(replyTo && { reply_to: replyTo }),
  });
  const names = [
    ...(((payload as { mentions?: string[] }).mentions ?? []) as string[]),
    ...(((payload as { agent_mentions?: unknown[] }).agent_mentions ?? []) as unknown[]),
  ].length;
  io.stdout(
    values.json
      ? JSON.stringify(outcome)
      : `Sent to "${record.session_name}" #${short(outcome.id)}${names ? ` (mentions ${names}; it shows in their inbox)` : ''}.`,
  );
  return 0;
}

export async function watch(argv: string[], io: Io): Promise<number> {
  const { values } = args(argv, {
    session: { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  const home = homeOf(io);
  const record = selectRecord(home, values.session);
  const identity = loadOrCreateDeviceIdentity(home);
  const endpoint = await resolveEndpoint(record);
  const names = new Map<string, string>();
  const titles = new Map<string, string>();
  let day: string | undefined;
  let failure: ClientError | undefined;
  const client = new SessionClient({
    host: record,
    endpoint,
    identity,
    // Watch shows the whole history each time; the local node keeps its own cursor separately.
    cursors: new MemoryCursorStore(),
    onEvent: (event) => {
      if (event.type === 'participant.joined') {
        names.set(event.actor_user_id, String(event.payload.display_name));
      }
      if (typeof event.payload.title === 'string') titles.set(event.id, event.payload.title);
      io.stdout(values.json ? JSON.stringify(event) : formatEvent(event, names, titles, day));
      day = localDay(event.received_at);
    },
    onStatus: (status, error) => {
      if (status === 'stopped' && error) failure = error;
      if (!values.json && status === 'offline' && error)
        io.stderr(`offline: ${error.message}; reconnecting`);
    },
  });
  client.start();
  await Promise.race([waitForAbort(io.signal), stoppedWithError(() => failure)]);
  await client.stop();
  if (failure) throw failure;
  return 0;
}

async function stoppedWithError(check: () => ClientError | undefined): Promise<void> {
  while (!check()) await new Promise((r) => setTimeout(r, 100).unref());
}

// Ids are UUIDs; the first 8 characters are enough to resolve, vote or reply from the CLI.
const short = (id: unknown) => String(id).slice(0, 8);

/** A full event id from a full id or a unique prefix, optionally of one event type. */
function expandId(history: SequencedEvent[], id: string, type?: string, label = 'event'): string {
  const matches = matching(history, id, type ? [type] : undefined);
  if (matches.length === 1 && matches[0]) return matches[0].id;
  throw new UsageError(
    matches.length ? `${id} matches several ${label}s; use more characters` : `no ${label} ${id}`,
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (iso: string) => {
  const at = new Date(iso);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

function formatEvent(
  event: SequencedEvent,
  names: Map<string, string>,
  titles: Map<string, string> = new Map(),
  previousDay?: string,
): string {
  const at = new Date(event.received_at);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  // Replays span days: print the local date whenever it changes.
  const day = localDay(event.received_at);
  const date = day !== previousDay ? `${day} ` : '';
  const name = names.get(event.actor_user_id) ?? event.actor_user_id;
  const who = event.actor_agent_id ? `${name}'s agent` : name;
  const p = event.payload;
  const ref = (id: unknown) => {
    const title = titles.get(String(id));
    return title ? `"${title}" #${short(id)}` : `#${short(id)}`;
  };
  const note = typeof p.note === 'string' && p.note ? `: ${p.note}` : '';
  const line = (text: string) => `[${date}${time}] ${who} ${text}`;
  switch (event.type) {
    case 'message.created':
      return event.reply_to
        ? `[${date}${time}] ${who} (re ${ref(event.reply_to)}): ${String(p.text)}`
        : `[${date}${time}] ${who}: ${String(p.text)}`;
    case 'participant.joined':
      return line(`joined as ${String(p.role)}`);
    case 'participant.left':
      return line('left');
    case 'presence.changed':
      return line(`is ${String(p.state).replace('_', ' ')}`);
    case 'context_package.published':
      return line(`shared "${String(p.title)}" #${short(event.id)}`);
    case 'request.created':
      return line(
        `asked ${((p.to ?? []) as string[]).map((u) => names.get(u) ?? u).join(', ')}: "${String(p.title)}" #${short(event.id)}`,
      );
    case 'request.resolved':
      return line(`marked request ${ref(p.request)} ${String(p.resolution)}${note}`);
    case 'review.finding':
      return line(`found [${String(p.severity)}] "${String(p.title)}" #${short(event.id)}`);
    case 'finding.resolved':
      return line(
        `marked finding ${ref(p.finding)} ${String(p.resolution).replace('_', ' ')}${note}`,
      );
    case 'decision.proposed':
      return line(`proposed "${String(p.title)}" #${short(event.id)}`);
    case 'decision.vote':
      return line(`votes ${String(p.stance)} on ${ref(p.decision)}${note}`);
    case 'decision.resolved':
      return line(`recorded decision ${ref(p.decision)} as ${String(p.outcome)}${note}`);
    default:
      return `[${date}${time}] ${who}: ${event.type}`;
  }
}

export async function status(argv: string[], io: Io): Promise<number> {
  const { values } = args(argv, { json: { type: 'boolean', default: false } });
  const records = listRecords(homeOf(io));
  if (values.json) {
    io.stdout(JSON.stringify({ sessions: records }));
    return 0;
  }
  if (records.length === 0) {
    io.stdout('No sessions. Start one with `pearcoder host --name <name>`.');
    return 0;
  }
  const reachable = await Promise.all(records.map((r) => isReachable(r)));
  records.forEach((r, i) => {
    const state = reachable[i] ? '' : '  (not reachable: host stopped or offline)';
    io.stdout(`${r.session_name}  ${r.session_id}  ${r.role}  ${r.addresses[0]}${state}`);
  });
  if (reachable.includes(false)) {
    io.stdout('Forget an ended session with: pearcoder forget <name|id>');
  }
  return 0;
}

async function isReachable(record: SessionRecord): Promise<boolean> {
  try {
    await Promise.race([
      resolveEndpoint(record),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000).unref()),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Forgets a session on this device (record and cursor). It does not leave or end it for others. */
export async function forget(argv: string[], io: Io): Promise<number> {
  const { positionals } = args(argv, {});
  if (!positionals[0]) throw new UsageError('pearcoder forget <session name|id>');
  const home = homeOf(io);
  const record = selectRecord(home, positionals[0]);
  removeRecord(home, record.session_id);
  io.stdout(
    `Forgot "${record.session_name}" on this device.${record.role === 'host' ? ' A persisted history stays in ~/.pearcoder/hosted; `host --resume` brings it back.' : ''}`,
  );
  return 0;
}

export async function whoami(argv: string[], io: Io): Promise<number> {
  const { values } = args(argv, {
    'set-name': { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  const home = homeOf(io);
  if (values['set-name'] !== undefined) writeProfile({ display_name: values['set-name'] }, home);
  const identity = loadOrCreateDeviceIdentity(home);
  const name = readProfile(home)?.display_name;
  if (values.json) {
    io.stdout(
      JSON.stringify({
        user_id: identity.userId,
        key_id: identity.keyId,
        display_name: name ?? null,
        home,
      }),
    );
  } else {
    io.stdout(`${name ?? '(no name set)'}  ${identity.userId}`);
    io.stdout(`Device key ${identity.keyId} in ${home}`);
  }
  return 0;
}

export async function ui(argv: string[], io: Io): Promise<number> {
  const { values } = args(argv, {
    port: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    notify: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('invalid --port');
  const home = homeOf(io);
  const node = await startLocalNode({
    home,
    identity: loadOrCreateDeviceIdentity(home),
    port,
    notifications: values.notify,
  });
  if (values.json) {
    io.stdout(JSON.stringify({ event: 'ui', url: node.openUrl }));
  } else {
    io.stdout(`Pearcoder is running at ${node.openUrl}`);
    io.stdout('Keep this link private: it lets the browser act as you. Press Ctrl-C to stop.');
  }
  if (io.isTTY && !values['no-open']) openBrowser(node.openUrl);
  await waitForAbort(io.signal);
  await node.close();
  return 0;
}

function parseExcerpt(spec: string): ExcerptSpec {
  const match = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(spec);
  if (!match?.[1]) throw new UsageError(`invalid --excerpt ${spec}; use path or path:10-40`);
  return {
    path: match[1],
    ...(match[2] && { startLine: Number(match[2]) }),
    ...(match[3] ? { endLine: Number(match[3]) } : match[2] ? { endLine: Number(match[2]) } : {}),
  };
}

export async function share(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = args(argv, {
    session: { type: 'string' },
    title: { type: 'string' },
    objective: { type: 'string' },
    constraint: { type: 'string', multiple: true },
    path: { type: 'string', multiple: true },
    excerpt: { type: 'string', multiple: true },
    base: { type: 'string' },
    pr: { type: 'string' },
    redact: { type: 'boolean', default: false },
    'allow-secrets': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });
  secretFlags(values);
  if (!values.objective && !values.pr) {
    throw new UsageError('pearcoder share [spec.md] --objective "what reviewers should look for"');
  }
  const cwd = io.env.PWD ?? process.cwd();
  const built = values.pr
    ? await buildPullRequestPackage({
        cwd,
        pr: values.pr,
        ...(values.objective && { objective: values.objective }),
        constraints: values.constraint ?? [],
        ...(io.env.PEARCODER_GH_BIN && { ghBin: io.env.PEARCODER_GH_BIN }),
      })
    : await buildContextPackage({
        cwd,
        ...(positionals[0] && { specFile: positionals[0] }),
        ...(values.title && { title: values.title }),
        // Checked above: without --pr an objective is required.
        objective: values.objective ?? '',
        constraints: values.constraint ?? [],
        paths: values.path ?? [],
        excerpts: (values.excerpt ?? []).map(parseExcerpt),
        ...(values.base && { base: values.base }),
      });
  let payload = built.payload;
  if (built.findings.length > 0) {
    if (values.redact) {
      const { hash: _old, ...rest } = redactValue(payload);
      payload = withContextPackageHash(rest);
    } else if (!values['allow-secrets']) {
      io.stderr('This package looks like it contains secrets or private details:');
      for (const f of built.findings)
        io.stderr(`  ${f.field}: ${f.kind.replaceAll('_', ' ')} (${f.preview})`);
      io.stderr(
        'Remove them, re-run with --redact to replace them, or --allow-secrets if they are safe.',
      );
      return 1;
    }
  }
  if (values['dry-run']) {
    io.stdout(JSON.stringify(payload, null, values.json ? 0 : 2));
    return 0;
  }
  const home = homeOf(io);
  const record = selectRecord(home, values.session);
  const client = await connect(record, loadOrCreateDeviceIdentity(home));
  const outcome = await client.append({ type: 'context_package.published', payload });
  const { id } = outcome;
  if (values.json) {
    io.stdout(
      JSON.stringify({ id, sequence: outcome.sequence, hash: payload.hash, bytes: built.bytes }),
    );
  } else {
    io.stdout(
      `Shared "${String(payload.title)}" with "${record.session_name}" (${Math.ceil(built.bytes / 1024)} KiB).`,
    );
    io.stdout(
      `Package ${id}. Ask for a review: pearcoder request --to <name> --package ${id} "<title>"`,
    );
  }
  return 0;
}

export async function request(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = args(argv, {
    session: { type: 'string' },
    to: { type: 'string', multiple: true },
    kind: { type: 'string', default: 'review' },
    package: { type: 'string' },
    body: { type: 'string' },
    'for-agent': { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  const title = positionals.join(' ').trim();
  if (!title || !values.to?.length) throw new UsageError('pearcoder request --to <name> "<title>"');
  const forAgent = values['for-agent'] ? AGENT_FLAGS[values['for-agent']] : undefined;
  if (values['for-agent'] && !forAgent) throw new UsageError('--for-agent must be claude or codex');
  if (!['review', 'question', 'discussion'].includes(values.kind)) {
    throw new UsageError('--kind must be review, question or discussion');
  }
  const home = homeOf(io);
  const record = selectRecord(home, values.session);
  const client = await connect(record, loadOrCreateDeviceIdentity(home));
  const history = await client.history();
  let people: ReturnType<typeof findParticipants>;
  try {
    people = findParticipants(history, values.to);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  let pkg = values.package;
  if (pkg === 'latest') {
    pkg = packagesOf(history).at(-1)?.id;
    if (!pkg) throw new UsageError('no context package in this session yet: pearcoder share …');
  } else if (pkg) {
    pkg = expandId(history, pkg, 'context_package.published', 'context package');
  }
  const outcome = await client.append({
    type: 'request.created',
    payload: {
      to: people.map((p) => p.user_id),
      kind: values.kind,
      title,
      ...(values.body && { body: values.body }),
      ...(pkg && { context_package: pkg }),
      ...(forAgent && { for_agent: forAgent }),
    },
  });
  const names = people.map((p) => p.display_name).join(', ');
  io.stdout(
    values.json
      ? JSON.stringify({
          id: outcome.id,
          sequence: outcome.sequence,
          to: people.map((p) => p.user_id),
        })
      : `Asked ${names}${forAgent ? ` to use their ${AGENT_LABEL[forAgent]}` : ''}: "${title}" #${short(outcome.id)}. They see it in their inbox; their agents are not started.`,
  );
  return 0;
}

export async function inbox(argv: string[], io: Io): Promise<number> {
  const { values } = args(argv, {
    session: { type: 'string' },
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });
  const home = homeOf(io);
  const identity = loadOrCreateDeviceIdentity(home);
  const records = values.session ? [selectRecord(home, values.session)] : listRecords(home);
  const rows: { session: string; request: ReturnType<typeof requestsOf>[number] }[] = [];
  const mentioned: { session: string; mention: ReturnType<typeof mentionsOf>[number] }[] = [];
  for (const record of records) {
    try {
      const history = await (await connect(record, identity)).history();
      const list = values.all
        ? requestsOf(history).filter((r) => r.to.includes(identity.userId))
        : inboxOf(history, identity.userId);
      for (const r of list) rows.push({ session: record.session_name, request: r });
      for (const m of mentionsOf(history, identity.userId)) {
        mentioned.push({ session: record.session_name, mention: m });
      }
    } catch (error) {
      io.stderr(`${record.session_name}: ${(error as Error).message}`);
    }
  }
  if (values.json) {
    io.stdout(
      JSON.stringify({
        requests: rows.map((r) => ({ session: r.session, ...r.request })),
        mentions: mentioned.map((m) => ({ session: m.session, ...m.mention })),
      }),
    );
    return 0;
  }
  if (rows.length === 0 && mentioned.length === 0) {
    io.stdout('Inbox empty.');
    return 0;
  }
  for (const { session, mention: m } of mentioned) {
    const whom = m.agent ? `your ${AGENT_LABEL[m.agent] ?? m.agent}` : 'you';
    io.stdout(
      `${short(m.id)}  [${session}] ${m.from_name} mentioned ${whom}: ${m.text.slice(0, 120)}`,
    );
    if (m.agent) {
      io.stdout(
        m.agent === 'codex'
          ? `          in Codex: use the pearcoder-discuss skill for ${short(m.id)}`
          : `          in Claude Code: /pearcoder:discuss ${short(m.id)}`,
      );
    }
  }
  for (const { session, request: r } of rows) {
    const mine = r.resolutions[identity.userId];
    const state = values.all ? `${mine ?? 'open'}  ` : '';
    const agent = r.for_agent ? ` (for your ${AGENT_LABEL[r.for_agent] ?? r.for_agent})` : '';
    io.stdout(
      `${short(r.id)}  ${state}[${session}] ${r.kind}${agent} from ${r.from_name}: ${r.title}`,
    );
    if (!mine && r.kind === 'review') {
      io.stdout(
        r.for_agent === 'codex'
          ? `          in Codex: use the pearcoder-review skill for ${short(r.id)}`
          : `          in Claude Code: /pearcoder:review ${short(r.id)}`,
      );
    }
  }
  if (rows.length) {
    io.stdout(
      'Handle one in Claude Code with /pearcoder:review, or: pearcoder resolve <id> accepted|declined|done',
    );
  }
  if (mentioned.length) io.stdout('Answer a mention with `pearcoder say --reply <id> "…"`.');
  return 0;
}

const AGENT_FLAGS: Record<string, AgentHarness> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
};
const AGENT_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

function namesIn(history: SequencedEvent[]): (userId: string) => string {
  const names = new Map<string, string>();
  for (const e of history) {
    if (e.type === 'participant.joined') names.set(e.actor_user_id, String(e.payload.display_name));
  }
  return (userId) => names.get(userId) ?? userId.slice(0, 12);
}

export async function findings(argv: string[], io: Io): Promise<number> {
  const { values } = args(argv, {
    session: { type: 'string' },
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });
  const home = homeOf(io);
  const record = selectRecord(home, values.session);
  const history = await (await connect(record, loadOrCreateDeviceIdentity(home))).history();
  const name = namesIn(history);
  const list = findingsOf(history).filter((f) => values.all || !f.resolution);
  if (values.json) {
    io.stdout(JSON.stringify({ findings: list }));
    return 0;
  }
  if (list.length === 0) {
    io.stdout(
      values.all ? 'No findings yet.' : 'No open findings. Use --all to see resolved ones.',
    );
    return 0;
  }
  for (const f of list) {
    const state = f.resolution ? f.resolution.resolution.replace('_', ' ') : 'open';
    const by = `${name(f.author)}${f.agent ? ' (agent)' : ''}`;
    const where = f.location ? `  ${f.location}` : '';
    const replies = f.replies.length
      ? `  ${f.replies.length} repl${f.replies.length === 1 ? 'y' : 'ies'}`
      : '';
    io.stdout(
      `${short(f.id)}  ${f.severity.padEnd(8)} ${state.padEnd(13)} ${f.title}  by ${by}${where}${replies}`,
    );
  }
  io.stdout('Resolve one: pearcoder resolve <id> fixed|accepted_risk|wont_fix|invalid');
  return 0;
}

export async function decisions(argv: string[], io: Io): Promise<number> {
  const { values } = args(argv, {
    session: { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  const home = homeOf(io);
  const record = selectRecord(home, values.session);
  const history = await (await connect(record, loadOrCreateDeviceIdentity(home))).history();
  const name = namesIn(history);
  const list = decisionsOf(history);
  if (values.json) {
    io.stdout(JSON.stringify({ decisions: list }));
    return 0;
  }
  if (list.length === 0) {
    io.stdout('No decisions yet. Propose one: pearcoder decide "<title>" --decision "…"');
    return 0;
  }
  for (const d of list) {
    const votes = Object.entries(d.votes)
      .map(([user, v]) => `${name(user)} ${v.stance}`)
      .join(', ');
    io.stdout(
      `${short(d.id)}  ${(d.outcome?.outcome ?? 'open').padEnd(10)} ${d.title}  by ${name(d.proposer)}`,
    );
    io.stdout(`          ${d.decision}${votes ? `  [${votes}]` : ''}`);
  }
  return 0;
}

const RESOLUTIONS: Record<string, { type: string; field: string; key: string; values: string[] }> =
  {
    'request.created': {
      type: 'request.resolved',
      field: 'request',
      key: 'resolution',
      values: ['accepted', 'declined', 'done'],
    },
    'review.finding': {
      type: 'finding.resolved',
      field: 'finding',
      key: 'resolution',
      values: ['fixed', 'accepted_risk', 'wont_fix', 'invalid'],
    },
    'decision.proposed': {
      type: 'decision.resolved',
      field: 'decision',
      key: 'outcome',
      values: ['accepted', 'rejected', 'superseded'],
    },
  };

export async function resolve(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = args(argv, {
    session: { type: 'string' },
    note: { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  const [id, outcome] = positionals;
  if (!id || !outcome) {
    throw new UsageError(
      'pearcoder resolve <id> <outcome>: requests accepted|declined|done, findings fixed|accepted_risk|wont_fix|invalid, decisions accepted|rejected|superseded',
    );
  }
  const home = homeOf(io);
  const identity = loadOrCreateDeviceIdentity(home);
  const records = values.session ? [selectRecord(home, values.session)] : listRecords(home);
  for (const record of records) {
    const client = await connect(record, identity);
    const found = matching(await client.history(), id, Object.keys(RESOLUTIONS));
    if (found.length > 1) {
      throw new UsageError(
        `${id} matches ${found.map((e) => `${e.type.split('.')[0]} ${short(e.id)}`).join(', ')}; use more characters`,
      );
    }
    const target = found[0];
    const rule = target && RESOLUTIONS[target.type];
    if (!target || !rule) continue;
    if (!rule.values.includes(outcome)) {
      throw new UsageError(
        `a ${target.type === 'review.finding' ? 'finding' : target.type.split('.')[0]} resolves as ${rule.values.join(', ')}`,
      );
    }
    const result = await client.append({
      type: rule.type,
      payload: {
        [rule.field]: target.id,
        [rule.key]: outcome,
        ...(values.note && { note: values.note }),
      },
    });
    io.stdout(
      values.json
        ? JSON.stringify(result)
        : `Marked as ${outcome.replaceAll('_', ' ')} in "${record.session_name}".`,
    );
    return 0;
  }
  throw new UsageError(`nothing with id ${id} to resolve in your sessions`);
}

export async function decide(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = args(argv, {
    session: { type: 'string' },
    decision: { type: 'string' },
    rationale: { type: 'string' },
    alternative: { type: 'string', multiple: true },
    related: { type: 'string', multiple: true },
    json: { type: 'boolean', default: false },
  });
  const title = positionals.join(' ').trim();
  if (!title || !values.decision) {
    throw new UsageError(
      'pearcoder decide "<title>" --decision "<what we agree to do>" [--rationale …] [--alternative …] [--related <id>]',
    );
  }
  const home = homeOf(io);
  const record = selectRecord(home, values.session);
  const client = await connect(record, loadOrCreateDeviceIdentity(home));
  const history = values.related?.length ? await client.history() : [];
  const related = values.related?.map((id) => expandId(history, id));
  const result = await client.append({
    type: 'decision.proposed',
    payload: {
      title,
      decision: values.decision,
      ...(values.rationale && { rationale: values.rationale }),
      ...(values.alternative?.length && { alternatives: values.alternative }),
      ...(related?.length && { related }),
    },
  });
  io.stdout(
    values.json
      ? JSON.stringify(result)
      : `Proposed "${title}" (${result.id}). Others: pearcoder vote ${result.id.slice(0, 8)} agree|disagree|abstain`,
  );
  return 0;
}

export async function vote(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = args(argv, {
    session: { type: 'string' },
    note: { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  const [id, stance] = positionals;
  if (!id || !stance || !['agree', 'disagree', 'abstain'].includes(stance)) {
    throw new UsageError('pearcoder vote <decision-id> agree|disagree|abstain [--note …]');
  }
  const home = homeOf(io);
  const identity = loadOrCreateDeviceIdentity(home);
  const records = values.session ? [selectRecord(home, values.session)] : listRecords(home);
  for (const record of records) {
    const client = await connect(record, identity);
    const found = matching(await client.history(), id, ['decision.proposed']);
    if (found.length > 1) {
      throw new UsageError(`${id} matches several decisions; use more characters`);
    }
    const decision = found[0];
    if (!decision) continue;
    const result = await client.append({
      type: 'decision.vote',
      payload: { decision: decision.id, stance, ...(values.note && { note: values.note }) },
    });
    io.stdout(
      values.json
        ? JSON.stringify(result)
        : `Recorded: ${stance} on "${String(decision.payload.title)}".`,
    );
    return 0;
  }
  throw new UsageError(`no decision ${id} in your sessions`);
}

export async function exportSession(argv: string[], io: Io): Promise<number> {
  const { values } = args(argv, {
    session: { type: 'string' },
    format: { type: 'string', default: 'md' },
    out: { type: 'string' },
    'no-footer': { type: 'boolean', default: false },
  });
  if (values.format !== 'md' && values.format !== 'jsonl')
    throw new UsageError('--format md|jsonl');
  const home = homeOf(io);
  const record = selectRecord(home, values.session);
  const events = await (await connect(record, loadOrCreateDeviceIdentity(home))).history();
  const text =
    values.format === 'md'
      ? renderReviewMarkdown(events, {
          sessionName: record.session_name,
          footer: !values['no-footer'],
        })
      : renderJsonl(events);
  if (values.out) {
    const { writeFileSync } = await import('node:fs');
    try {
      writeFileSync(values.out, text);
    } catch (error) {
      throw new UsageError(
        `cannot write ${values.out}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
    io.stderr(`Wrote ${values.out} (${events.length} events).`);
  } else {
    io.stdout(text.trimEnd());
  }
  return 0;
}

export async function verify(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = args(argv, { json: { type: 'boolean', default: false } });
  if (!positionals[0]) throw new UsageError('pearcoder verify <export.jsonl>');
  const { readFileSync } = await import('node:fs');
  let text: string;
  try {
    text = readFileSync(positionals[0], 'utf8');
  } catch {
    throw new UsageError(`cannot read ${positionals[0]}`);
  }
  const report = verifyExport(text);
  if (values.json) io.stdout(JSON.stringify(report));
  else if (report.ok && report.sealed) {
    io.stdout(
      `OK: ${report.events} events. Every signature verifies and the host's chain is unbroken: nothing was removed, reordered or re-timed. (A log cut short at the end is still a valid prefix.)`,
    );
  } else if (report.ok) {
    io.stdout(
      `OK: ${report.events} events with valid author signatures. This log has no host seal (older host), so removed events cannot be detected.`,
    );
  } else {
    for (const p of report.problems.slice(0, 10)) io.stderr(p);
    if (report.problems.length > 10)
      io.stderr(`… and ${report.problems.length - 10} more problems`);
  }
  return report.ok ? 0 : 1;
}

/**
 * Turns the session's findings about a GitHub PR into one review on that PR: inline comments where
 * the line is in the diff, the rest in the review body. Shows a preview unless --post is given;
 * Pearcoder never posts on its own.
 */
export async function githubReview(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = args(argv, {
    session: { type: 'string' },
    'include-resolved': { type: 'boolean', default: false },
    post: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });
  if (!positionals[0]) throw new UsageError('pearcoder github-review <pr number|url> [--post]');
  const home = homeOf(io);
  const record = selectRecord(home, values.session);
  const history = await (await connect(record, loadOrCreateDeviceIdentity(home))).history();
  const options = {
    cwd: io.env.PWD ?? process.cwd(),
    ...(io.env.PEARCODER_GH_BIN && { ghBin: io.env.PEARCODER_GH_BIN }),
  };
  const plan = await planGithubReview(history, {
    ...options,
    pr: positionals[0],
    includeResolved: values['include-resolved'],
  });
  if (plan.findings.length === 0) {
    io.stdout(
      values.json
        ? JSON.stringify({ posted: false, plan })
        : `No ${values['include-resolved'] ? '' : 'open '}findings about ${plan.url} in this session.`,
    );
    return 0;
  }
  if (!values.post) {
    if (values.json) {
      io.stdout(JSON.stringify({ posted: false, plan }));
      return 0;
    }
    io.stdout(`Review for ${plan.url} at ${plan.commitId.slice(0, 12)}:`);
    for (const c of plan.comments)
      io.stdout(`  inline  ${c.path}:${c.line}  ${c.body.split('\n')[0]}`);
    const inBody = plan.findings.length - plan.comments.length;
    if (inBody)
      io.stdout(`  ${inBody} more in the review body (not on a line in the current diff)`);
    if (plan.redacted)
      io.stdout(
        `  ${plan.redacted} secret${plan.redacted === 1 ? '' : 's'} redacted before posting`,
      );
    io.stdout('');
    io.stdout(
      'This posts the findings to GitHub, where everyone with access to the repository can read them.',
    );
    io.stdout(`Post it with: pearcoder github-review ${positionals[0]} --post`);
    return 0;
  }
  const posted = await postGithubReview(plan, options);
  io.stdout(
    values.json
      ? JSON.stringify({ posted: true, url: posted.url, plan })
      : `Posted ${plan.findings.length} finding${plan.findings.length === 1 ? '' : 's'} to ${posted.url}. Running this again posts another review.`,
  );
  return 0;
}

/** MCP server for the owner's own agent, over stdio. Started by Claude Code, not by people. */
export async function mcp(argv: string[], io: Io): Promise<number> {
  args(argv, {});
  const home = homeOf(io);
  await runStdioServer({ home, identity: loadOrCreateDeviceIdentity(home) }, io.signal);
  return 0;
}

export async function drafts(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = args(argv, {
    session: { type: 'string' },
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });
  const home = homeOf(io);
  if (positionals[0]) {
    const draft = getDraft(home, positionals[0]);
    if (values.json) io.stdout(JSON.stringify(draft));
    else {
      io.stdout(
        `${draft.id}  [${draft.status}] ${draft.kind} via ${draft.source.via}${draft.source.harness ? ` (${draft.source.harness})` : ''}`,
      );
      if (draft.kind === 'finding') {
        const p = draft.payload;
        io.stdout(`${p.severity.toUpperCase()}: ${p.title}`);
        if (p.location)
          io.stdout(
            `at ${p.location.path}${p.location.start_line ? `:${p.location.start_line}` : ''}`,
          );
        io.stdout('');
        io.stdout(p.body);
      } else {
        io.stdout(`Reply to ${draft.payload.reply_to}`);
        io.stdout('');
        io.stdout(draft.payload.text);
      }
    }
    return 0;
  }
  const sessionId = values.session ? selectRecord(home, values.session).session_id : undefined;
  const list = listDrafts(home, {
    ...(sessionId && { sessionId }),
    ...(!values.all && { status: 'draft' as const }),
  });
  if (values.json) {
    io.stdout(JSON.stringify({ drafts: list }));
    return 0;
  }
  if (list.length === 0) {
    io.stdout('No drafts. Your agent saves them with /pearcoder:review.');
    return 0;
  }
  const names = new Map(listRecords(home).map((r) => [r.session_id, r.session_name]));
  for (const d of list) {
    io.stdout(
      `${d.id.slice(0, 8)}  [${names.get(d.session_id) ?? d.session_id}] ${d.kind === 'finding' ? `${d.payload.severity}: ` : ''}${draftTitle(d)}${values.all ? ` (${d.status})` : ''}`,
    );
  }
  io.stdout(
    'Read one: pearcoder drafts <id>. Share it: pearcoder publish <id>. Drop it: pearcoder discard <id>.',
  );
  return 0;
}

export async function publish(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = args(argv, {
    redact: { type: 'boolean', default: false },
    'allow-secrets': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });
  if (!positionals[0])
    throw new UsageError('pearcoder publish <draft-id> [--redact | --allow-secrets]');
  secretFlags(values);
  const home = homeOf(io);
  try {
    const result = await publishDraft(home, loadOrCreateDeviceIdentity(home), positionals[0], {
      redact: values.redact,
      allowSecrets: values['allow-secrets'],
    });
    io.stdout(
      values.json
        ? JSON.stringify({
            draft: result.draft.id,
            event: result.eventId,
            sequence: result.sequence,
          })
        : `Published "${draftTitle(result.draft)}" #${short(result.eventId)}.`,
    );
    if (values['allow-secrets'] && !values.json) {
      io.stderr(
        'Published without the secret check (--allow-secrets): everyone in the session can read it.',
      );
    }
    return 0;
  } catch (error) {
    if (!(error instanceof PublishBlockedError)) throw error;
    io.stderr('Not published: the draft looks like it contains secrets or private details:');
    for (const f of error.findings)
      io.stderr(`  ${f.field}: ${f.kind.replaceAll('_', ' ')} (${f.preview})`);
    io.stderr(
      'Edit it, or re-run with --redact to replace them, or --allow-secrets if they are safe.',
    );
    return 1;
  }
}

export async function discard(argv: string[], io: Io): Promise<number> {
  const { positionals } = args(argv, {});
  if (!positionals[0]) throw new UsageError('pearcoder discard <draft-id>');
  const draft = discardDraft(homeOf(io), positionals[0]);
  io.stdout(`Discarded "${draftTitle(draft)}". It was never shared.`);
  return 0;
}

export async function attach(argv: string[], io: Io): Promise<number> {
  const { values } = args(argv, {
    agent: { type: 'string', default: 'claude' },
    'dry-run': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });
  if (values.agent !== 'claude' && values.agent !== 'codex') {
    throw new UsageError('--agent claude or --agent codex');
  }
  const home = homeOf(io);
  const common = {
    home,
    defaultHome: io.env.PEARCODER_HOME === undefined,
    nodePath: process.execPath,
    binPath: cliEntry(),
  };
  if (values.agent === 'codex') return attachCodex(io, values, common);
  if (!pluginShipped()) throw new UsageError('the Claude Code plugin is missing from this install');
  const commands = claudeAttachCommands({ ...common, marketplace: marketplaceDir() });
  const claudeBin = io.env.PEARCODER_CLAUDE_BIN ?? 'claude';
  if (values['dry-run']) {
    for (const c of commands)
      io.stdout(
        `${claudeBin} ${c.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`,
      );
    return 0;
  }
  const version = await runClaude(['--version'], claudeBin);
  if (!version.ok) {
    throw new UsageError('Claude Code is not installed or not on PATH: https://code.claude.com');
  }
  for (const command of commands) {
    const result = await runClaude(command.args, claudeBin);
    if (!result.ok && !command.optional) {
      io.stderr(`claude ${command.args.join(' ')} failed:\n${result.output}`);
      return 1;
    }
  }
  recordAttachedAgent('claude-code', common.home);
  if (values.json) {
    io.stdout(JSON.stringify({ attached: 'claude', claude_version: version.output }));
  } else {
    io.stdout(`Attached to Claude Code (${version.output}).`);
    io.stdout(
      '- MCP server `pearcoder` registered for your user (read sessions, save private drafts; it cannot publish).',
    );
    io.stdout(
      '- Plugin installed: /pearcoder:review runs the restricted pearcoder-reviewer subagent (no shell, no edits, no web).',
    );
    io.stdout(
      '- Your sessions now show "Claude Code" next to your name, so people can address review requests to it. It still only runs when you start it.',
    );
    io.stdout('');
    io.stdout('Next:');
    io.stdout('  1. Restart Claude Code and open it in the repository to review.');
    io.stdout(
      '  2. Run /pearcoder:review. It picks your oldest open review request; to pick one, add its id from `pearcoder inbox` (e.g. /pearcoder:review 4044de9b).',
    );
    io.stdout(
      '  3. Check the drafts it saved (`pearcoder drafts` or the web UI) and publish the ones you agree with.',
    );
    io.stdout(
      'The first time, Claude Code asks to allow the Pearcoder tools: choose "always allow" for them.',
    );
  }
  return 0;
}

async function attachCodex(
  io: Io,
  values: { 'dry-run': boolean; json: boolean },
  common: { home: string; defaultHome: boolean; nodePath: string; binPath: string },
): Promise<number> {
  const userHome = io.env.HOME ?? io.env.USERPROFILE ?? homedir();
  const plan = codexAttachPlan({
    ...common,
    codexHome: io.env.CODEX_HOME ?? joinPath(userHome, '.codex'),
    userHome,
    integration: codexIntegrationDir(),
  });
  const codexBin = io.env.PEARCODER_CODEX_BIN ?? 'codex';
  if (values['dry-run']) {
    for (const c of plan.commands)
      io.stdout(
        `${codexBin} ${c.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`,
      );
    for (const f of plan.files) io.stdout(`install ${f.to}`);
    return 0;
  }
  const version = await runClaude(['--version'], codexBin);
  if (!version.ok) throw new UsageError('Codex is not installed or not on PATH');
  for (const command of plan.commands) {
    const result = await runClaude(command.args, codexBin);
    if (!result.ok && !command.optional) {
      io.stderr(`codex ${command.args.join(' ')} failed:\n${result.output}`);
      return 1;
    }
  }
  const { cpSync, mkdirSync } = await import('node:fs');
  for (const f of plan.files) {
    mkdirSync(dirname(f.to), { recursive: true });
    cpSync(f.from, f.to);
  }
  recordAttachedAgent('codex', common.home);
  if (values.json) {
    io.stdout(
      JSON.stringify({
        attached: 'codex',
        codex_version: version.output,
        files: plan.files.map((f) => f.to),
      }),
    );
  } else {
    io.stdout(`Attached to Codex (${version.output}).`);
    io.stdout(
      '- MCP server `pearcoder` registered (read sessions, save private drafts; it cannot publish).',
    );
    io.stdout('- Installed the pearcoder-reviewer subagent and the pearcoder-review skill.');
    io.stdout(
      'Review with a read-only sandbox: codex --sandbox read-only, then ask it to use the pearcoder-review skill (it picks your oldest open request; ids are in `pearcoder inbox`).',
    );
    io.stdout(
      'Codex cannot allowlist subagent tools, so the read-only sandbox is what keeps the review from writing or reaching the network.',
    );
  }
  return 0;
}

export async function doctor(argv: string[], io: Io): Promise<number> {
  const { values } = args(argv, { json: { type: 'boolean', default: false } });
  const home = homeOf(io);
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  try {
    const identity = loadOrCreateDeviceIdentity(home);
    checks.push({ name: 'identity', ok: true, detail: identity.userId });
  } catch (error) {
    checks.push({ name: 'identity', ok: false, detail: (error as Error).message });
  }
  const name = readProfile(home)?.display_name;
  checks.push({
    name: 'name',
    ok: Boolean(name),
    detail: name ?? 'set with pearcoder whoami --set-name <name>',
  });
  for (const record of listRecords(home)) {
    try {
      await resolveEndpoint(record);
      checks.push({
        name: `session ${record.session_name}`,
        ok: true,
        detail: `${record.role}, host reachable`,
      });
    } catch (error) {
      checks.push({
        name: `session ${record.session_name}`,
        ok: false,
        detail: (error as Error).message,
      });
    }
  }
  const claudeBin = io.env.PEARCODER_CLAUDE_BIN ?? 'claude';
  const version = await runClaude(['--version'], claudeBin);
  checks.push({
    name: 'claude code',
    ok: version.ok,
    detail: version.ok ? version.output : 'not found on PATH',
  });
  if (version.ok) {
    const mcpServer = await runClaude(['mcp', 'get', 'pearcoder'], claudeBin);
    checks.push({
      name: 'mcp server',
      ok: mcpServer.ok,
      detail: mcpServer.ok ? 'pearcoder registered' : 'run pearcoder attach --agent claude',
    });
    const plugins = await runClaude(['plugin', 'list'], claudeBin);
    const installed = plugins.ok && /pearcoder@pearcoder/.test(plugins.output);
    checks.push({
      name: 'plugin',
      ok: installed,
      detail: installed ? 'pearcoder installed' : 'run pearcoder attach --agent claude',
    });
  }
  // Codex is optional: only reported when it is installed.
  const codexBin = io.env.PEARCODER_CODEX_BIN ?? 'codex';
  const codex = await runClaude(['--version'], codexBin);
  if (codex.ok) {
    const server = await runClaude(['mcp', 'get', 'pearcoder'], codexBin);
    const codexHome = io.env.CODEX_HOME ?? joinPath(io.env.HOME ?? homedir(), '.codex');
    const { existsSync } = await import('node:fs');
    const agent = existsSync(joinPath(codexHome, 'agents', 'pearcoder-reviewer.toml'));
    checks.push({
      name: 'codex',
      ok: server.ok && agent,
      detail:
        server.ok && agent
          ? `${codex.output}, pearcoder attached`
          : 'run pearcoder attach --agent codex',
    });
  }
  if (values.json) io.stdout(JSON.stringify({ checks }));
  else for (const c of checks) io.stdout(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  return checks.every((c) => c.ok) ? 0 : 1;
}
