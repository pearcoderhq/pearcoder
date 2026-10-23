import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DeviceIdentity } from '@pearcoderhq/core';
import {
  type AgentId,
  clientProofMessage,
  decodeInvitation,
  hostProofMessage,
  type Invitation,
  keyIdFromPublicKey,
  newEventId,
  PROTOCOL_VERSION,
  publicKeyFromRaw,
  type SequencedEvent,
  SequencedEventSchema,
  type SignedEvent,
  signEvent,
  signProof,
  type ThreadId,
  type UnsignedEvent,
  verifyProof,
  WS_AUTH_PREFIX,
  WS_PROTOCOL,
} from '@pearcoderhq/protocol';
import WebSocket from 'ws';
import { type CursorStore, MemoryCursorStore } from './cursor.js';
import { ClientError } from './errors.js';
import { type Endpoint, requestJson } from './http.js';
import { pinnedAgent } from './tls.js';

/** What a client needs to know about the host; all of it comes from the invitation. */
export type HostInfo = Pick<
  Invitation,
  'session_id' | 'session_name' | 'host_user_id' | 'host_public_key'
>;

export type ClientStatus = 'connecting' | 'online' | 'offline' | 'stopped';

export interface SessionClientOptions {
  host: HostInfo;
  endpoint: Endpoint;
  identity: DeviceIdentity;
  cursors?: CursorStore;
  onEvent?: (event: SequencedEvent) => void;
  onStatus?: (status: ClientStatus, error?: ClientError) => void;
  /** Reconnect backoff bounds in ms (exponential with jitter). */
  backoff?: { minMs: number; maxMs: number };
  ackTimeoutMs?: number;
}

export interface AppendOutcome {
  /** The event id (references such as `request` and `context_package` use it). */
  id: string;
  status: 'appended' | 'duplicate';
  sequence: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const FATAL_CODES = new Set([
  'HOST_PROOF_INVALID',
  'TLS_FINGERPRINT_MISMATCH',
  'NOT_A_PARTICIPANT',
  'SESSION_NOT_FOUND',
]);

/**
 * Picks the first reachable invitation address. Remote addresses must be HTTPS: pinned to the
 * invitation's fingerprint when it has one, CA-validated otherwise. Plain HTTP is loopback-only.
 */
export async function resolveEndpoint(
  invitation: Pick<Invitation, 'addresses' | 'tls_fingerprint'>,
): Promise<Endpoint> {
  const errors: string[] = [];
  for (const address of invitation.addresses) {
    const url = new URL(address);
    try {
      let endpoint: Endpoint;
      if (url.protocol === 'http:') {
        if (!LOOPBACK_HOSTS.has(url.hostname)) {
          throw new ClientError('INSECURE_ADDRESS', `${url.host} is not loopback and not HTTPS`);
        }
        endpoint = { baseUrl: url.origin };
      } else if (invitation.tls_fingerprint) {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const port = Number(url.port || 443);
        endpoint = {
          baseUrl: url.origin,
          agent: await pinnedAgent(host, port, invitation.tls_fingerprint),
        };
      } else {
        endpoint = { baseUrl: url.origin };
      }
      await requestJson(endpoint, 'GET', '/v1/health', { timeoutMs: 5_000 });
      return endpoint;
    } catch (error) {
      // A fingerprint mismatch is an attack signal, not a reachability problem: stop here.
      if (error instanceof ClientError && error.code === 'TLS_FINGERPRINT_MISMATCH') throw error;
      errors.push(`${url.host}: ${(error as Error).message}`);
    }
  }
  throw new ClientError(
    'HOST_UNREACHABLE',
    `the host is not reachable; is it still running? (${errors.join('; ')})`,
  );
}

/** Joins with an invitation token: finds the host, then sends a self-signed participant.joined. */
export async function joinSession(
  token: string,
  identity: DeviceIdentity,
  displayName: string,
): Promise<{ host: Invitation; endpoint: Endpoint; event: SequencedEvent }> {
  const invitation = decodeInvitation(token);
  const endpoint = await resolveEndpoint(invitation);
  const joinEvent = signEvent(
    {
      id: newEventId(),
      session_id: invitation.session_id,
      timestamp: new Date().toISOString(),
      actor_user_id: identity.userId,
      type: 'participant.joined',
      thread_id: 'main',
      version: PROTOCOL_VERSION,
      payload: {
        display_name: displayName,
        public_key: identity.publicKey,
        key_id: keyIdFromPublicKey(Buffer.from(identity.publicKey, 'base64url')),
        role: invitation.role,
      },
    },
    identity.privateKey,
  );
  const result = await requestJson<{ event: unknown }>(
    endpoint,
    'POST',
    `/v1/sessions/${invitation.session_id}/join`,
    { body: { token, event: joinEvent } },
  );
  return { host: invitation, endpoint, event: SequencedEventSchema.parse(result.event) };
}

/**
 * A participant's live connection to a session host: login, ordered at-least-once delivery from
 * a persistent cursor, automatic reconnect with backoff, and idempotent appends.
 */
export class SessionClient {
  readonly host: HostInfo;
  readonly #endpoint: Endpoint;
  readonly #identity: DeviceIdentity;
  readonly #cursors: CursorStore;
  readonly #options: SessionClientOptions;
  #token: string | undefined;
  #socket: WebSocket | undefined;
  #stopped = false;
  #running: Promise<void> | undefined;
  readonly #pendingAcks = new Map<
    string,
    { resolve: (o: Omit<AppendOutcome, 'id'>) => void; reject: (e: ClientError) => void }
  >();

  constructor(options: SessionClientOptions) {
    this.host = options.host;
    this.#endpoint = options.endpoint;
    this.#identity = options.identity;
    this.#cursors = options.cursors ?? new MemoryCursorStore();
    this.#options = options;
  }

  get cursor(): number {
    return this.#cursors.get(this.host.session_id);
  }

  /** Starts the connect/stream/reconnect loop in the background. */
  start(): void {
    this.#stopped = false;
    this.#running ??= this.#run().finally(() => {
      this.#running = undefined;
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#socket?.close(1000, 'client stopped');
    await this.#running;
    this.#options.onStatus?.('stopped');
  }

  /**
   * Logs in with a mutual challenge: first checks the host's proof against the invitation's host
   * key (so an impostor at the address is detected), then proves this device's key.
   */
  async login(): Promise<string> {
    const base = `/v1/sessions/${this.host.session_id}`;
    const clientNonce = randomBytes(24).toString('base64url');
    const challenge = await requestJson<{
      host_user_id: string;
      host_nonce: string;
      host_proof: string;
    }>(this.#endpoint, 'POST', `${base}/challenge`, { body: { client_nonce: clientNonce } });
    const hostOk =
      challenge.host_user_id === this.host.host_user_id &&
      verifyProof(
        hostProofMessage({
          sessionId: this.host.session_id,
          hostUserId: this.host.host_user_id,
          clientNonce,
          hostNonce: challenge.host_nonce,
        }),
        challenge.host_proof,
        publicKeyFromRaw(this.host.host_public_key),
      );
    if (!hostOk)
      throw new ClientError('HOST_PROOF_INVALID', 'the host could not prove its identity');
    const proof = signProof(
      clientProofMessage({
        sessionId: this.host.session_id,
        hostUserId: this.host.host_user_id,
        userId: this.#identity.userId,
        hostNonce: challenge.host_nonce,
        clientNonce,
      }),
      this.#identity.privateKey,
    );
    const { token } = await requestJson<{ token: string }>(
      this.#endpoint,
      'POST',
      `${base}/token`,
      {
        body: {
          user_id: this.#identity.userId,
          host_nonce: challenge.host_nonce,
          client_nonce: clientNonce,
          proof,
        },
      },
    );
    this.#token = token;
    return token;
  }

  /** Signs and sends an event. Safe to retry: resending the same signed event is idempotent. */
  async append(
    event: Pick<UnsignedEvent, 'type' | 'payload'> & {
      thread_id?: ThreadId;
      reply_to?: string;
      /** Attribution when the owner publishes something their agent drafted. */
      actor_agent_id?: AgentId;
    },
  ): Promise<AppendOutcome> {
    const signed = signEvent(
      {
        id: newEventId(),
        session_id: this.host.session_id,
        timestamp: new Date().toISOString(),
        actor_user_id: this.#identity.userId,
        thread_id: event.thread_id ?? 'main',
        version: PROTOCOL_VERSION,
        type: event.type,
        payload: event.payload,
        ...(event.reply_to ? { reply_to: event.reply_to } : {}),
        ...(event.actor_agent_id ? { actor_agent_id: event.actor_agent_id } : {}),
      },
      this.#identity.privateKey,
    );
    return this.appendSigned(signed);
  }

  /** Every event after `after`, fetched over HTTP in pages (no stream needed). */
  async history(after = 0): Promise<SequencedEvent[]> {
    const events: SequencedEvent[] = [];
    let cursor = after;
    for (;;) {
      const page = await this.#withToken((token) =>
        requestJson<{ events: unknown[]; head: number }>(
          this.#endpoint,
          'GET',
          `/v1/sessions/${this.host.session_id}/events?after=${cursor}&limit=1000`,
          { token },
        ),
      );
      for (const raw of page.events) events.push(SequencedEventSchema.parse(raw));
      const last = events.at(-1)?.sequence ?? cursor;
      if (page.events.length === 0 || last >= page.head) return events;
      cursor = last;
    }
  }

  say(text: string, threadId: ThreadId = 'main'): Promise<AppendOutcome> {
    return this.append({ type: 'message.created', payload: { text }, thread_id: threadId });
  }

  async appendSigned(event: SignedEvent): Promise<AppendOutcome> {
    const outcome = await this.#send(event);
    return { id: event.id, status: outcome.status, sequence: outcome.sequence };
  }

  async #send(event: SignedEvent): Promise<Omit<AppendOutcome, 'id'>> {
    const socket = this.#socket;
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        return await this.#appendOverSocket(socket, event);
      } catch (error) {
        // Rejections from the host are final; transport problems fall back to HTTP below.
        if (!(error instanceof ClientError) || !['TIMEOUT', 'NETWORK'].includes(error.code))
          throw error;
      }
    }
    return this.#withToken((token) =>
      requestJson<Omit<AppendOutcome, 'id'>>(
        this.#endpoint,
        'POST',
        `/v1/sessions/${this.host.session_id}/events`,
        {
          body: event,
          token,
        },
      ),
    );
  }

  async #withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const token = this.#token ?? (await this.login());
    try {
      return await fn(token);
    } catch (error) {
      if (error instanceof ClientError && error.status === 401) {
        this.#token = undefined;
        return fn(await this.login());
      }
      throw error;
    }
  }

  #appendOverSocket(socket: WebSocket, event: SignedEvent): Promise<Omit<AppendOutcome, 'id'>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingAcks.delete(event.id);
        reject(new ClientError('TIMEOUT', 'no ack from host'));
      }, this.#options.ackTimeoutMs ?? 10_000);
      this.#pendingAcks.set(event.id, {
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ type: 'append', id: event.id, event }), (error) => {
        if (error)
          this.#pendingAcks.get(event.id)?.reject(new ClientError('NETWORK', error.message));
      });
    });
  }

  async #run(): Promise<void> {
    const { minMs, maxMs } = this.#options.backoff ?? { minMs: 500, maxMs: 30_000 };
    let attempt = 0;
    while (!this.#stopped) {
      this.#options.onStatus?.('connecting');
      try {
        this.#token ??= await this.login();
        await this.#stream(this.#token, () => {
          attempt = 0;
        });
      } catch (error) {
        const failure =
          error instanceof ClientError
            ? error
            : new ClientError('NETWORK', (error as Error).message);
        if (failure.status === 401) this.#token = undefined;
        if (this.#stopped) break;
        if (FATAL_CODES.has(failure.code)) {
          // Wrong host identity or removal from the session: retrying cannot help and must not
          // keep talking to a possible impostor.
          this.#stopped = true;
          this.#options.onStatus?.('stopped', failure);
          break;
        }
        this.#options.onStatus?.('offline', failure);
        const base = Math.min(maxMs, minMs * 2 ** attempt);
        attempt += 1;
        await delay(base / 2 + Math.random() * (base / 2));
      }
    }
  }

  /** One WebSocket connection. Resolves when it closes normally, rejects on failure. */
  #stream(token: string, onOnline: () => void): Promise<void> {
    const url = new URL(
      `/v1/sessions/${this.host.session_id}/stream?after=${this.cursor}`,
      this.#endpoint.baseUrl,
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, [WS_PROTOCOL, `${WS_AUTH_PREFIX}${token}`], {
        ...(this.#endpoint.agent ? { agent: this.#endpoint.agent } : {}),
        handshakeTimeout: 10_000,
        maxPayload: 16 * 1024 * 1024,
      });
      this.#socket = socket;
      let settled = false;
      const fail = (error: ClientError) => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(error);
      };

      socket.on('unexpected-response', (_req, res) => {
        fail(
          new ClientError(
            res.statusCode === 401 ? 'UNAUTHORIZED' : `HTTP_${res.statusCode}`,
            'stream refused',
            res.statusCode,
          ),
        );
      });
      socket.on('error', (error) =>
        fail(new ClientError('NETWORK', error.message, undefined, { cause: error })),
      );
      socket.on('message', (data) => {
        let message: {
          type?: string;
          event?: unknown;
          id?: unknown;
          status?: unknown;
          sequence?: unknown;
          code?: unknown;
          message?: unknown;
        };
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message.type === 'event') {
          const parsed = SequencedEventSchema.safeParse(message.event);
          if (!parsed.success) return;
          const cursor = this.cursor;
          if (parsed.data.sequence <= cursor) return; // duplicate after a reconnect
          if (parsed.data.sequence !== cursor + 1) {
            // A gap means we missed something: reconnect and replay from the cursor.
            fail(
              new ClientError('STREAM_GAP', `expected ${cursor + 1}, got ${parsed.data.sequence}`),
            );
            return;
          }
          this.#cursors.set(this.host.session_id, parsed.data.sequence);
          this.#options.onEvent?.(parsed.data);
        } else if (message.type === 'ready') {
          onOnline();
          this.#options.onStatus?.('online');
        } else if (message.type === 'ack' && typeof message.id === 'string') {
          this.#pendingAcks.get(message.id)?.resolve({
            status: message.status === 'duplicate' ? 'duplicate' : 'appended',
            sequence: Number(message.sequence),
          });
          this.#pendingAcks.delete(message.id);
        } else if (message.type === 'error' && typeof message.id === 'string') {
          this.#pendingAcks
            .get(message.id)
            ?.reject(
              new ClientError(
                String(message.code),
                typeof message.message === 'string' ? message.message : 'host rejected the event',
                typeof message.status === 'number' ? message.status : undefined,
              ),
            );
          this.#pendingAcks.delete(message.id);
        }
      });
      socket.on('close', (code) => {
        if (this.#socket === socket) this.#socket = undefined;
        for (const [id, pending] of this.#pendingAcks) {
          pending.reject(new ClientError('NETWORK', 'connection closed'));
          this.#pendingAcks.delete(id);
        }
        if (settled) return;
        settled = true;
        if (code === 4001) reject(new ClientError('UNAUTHORIZED', 'session token expired', 401));
        else if (this.#stopped || code === 1000) resolve();
        else reject(new ClientError('NETWORK', `stream closed (${code})`));
      });
    });
  }
}
