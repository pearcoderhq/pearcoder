import {
  type ClientError,
  type ClientStatus,
  listRecords,
  MemoryCursorStore,
  messageWithMentions,
  resolveEndpoint,
  SessionClient,
  type SessionRecord,
} from '@pearcoderhq/client';
import { type DeviceIdentity, readAttachedAgents } from '@pearcoderhq/core';
import type { AgentHarness, SequencedEvent, SessionId } from '@pearcoderhq/protocol';

export interface SessionView {
  session_id: SessionId;
  session_name: string;
  role: SessionRecord['role'];
  status: ClientStatus | 'unreachable';
  error?: string;
}

export type HubUpdate =
  | { type: 'event'; session_id: SessionId; event: SequencedEvent }
  | { type: 'status'; session_id: SessionId; status: SessionView['status']; error?: string };

interface Entry {
  record: SessionRecord;
  client?: SessionClient;
  events: SequencedEvent[];
  status: SessionView['status'];
  error?: string;
  announced: boolean;
}

const MAX_EVENTS_PER_SESSION = 10_000;

/**
 * This device's live connections to every session it has hosted or joined. The browser UI reads
 * from here through the local node; it never talks to session hosts itself.
 */
export class SessionHub {
  readonly #home: string;
  readonly #identity: DeviceIdentity;
  readonly #entries = new Map<SessionId, Entry>();
  readonly #listeners = new Set<(update: HubUpdate) => void>();
  #closed = false;
  #announcedAgents = '';

  constructor(home: string, identity: DeviceIdentity) {
    this.#home = home;
    this.#identity = identity;
  }

  /** Picks up sessions joined since the last call and retries unreachable ones. */
  async refresh(): Promise<void> {
    if (this.#closed) return;
    const records = listRecords(this.#home);
    // Sessions forgotten on this device (`pearcoder forget`, or a host that stopped) disappear.
    for (const [id, entry] of this.#entries) {
      if (records.some((r) => r.session_id === id)) continue;
      this.#entries.delete(id);
      await entry.client?.stop();
      this.#emit({ type: 'status', session_id: id, status: 'stopped' });
    }
    // `pearcoder attach` after the node started: tell every session without a restart.
    if (JSON.stringify(readAttachedAgents(this.#home)) !== this.#announcedAgents) {
      for (const entry of this.#entries.values()) {
        if (entry.status !== 'online') continue;
        entry.client
          ?.append({ type: 'presence.changed', payload: this.#onlinePresence() })
          .catch(() => undefined);
      }
    }
    for (const record of records) {
      const entry = this.#entries.get(record.session_id);
      if (entry?.client) continue;
      const next: Entry = entry ?? { record, events: [], status: 'connecting', announced: false };
      this.#entries.set(record.session_id, next);
      try {
        const endpoint = await resolveEndpoint(record);
        if (this.#closed) return;
        next.client = new SessionClient({
          host: record,
          endpoint,
          identity: this.#identity,
          cursors: new MemoryCursorStore(),
          onEvent: (event) => this.#onEvent(next, event),
          onStatus: (status, error) => this.#onStatus(next, status, error),
        });
        next.client.start();
      } catch (error) {
        this.#setStatus(next, 'unreachable', (error as Error).message);
      }
    }
  }

  sessions(): SessionView[] {
    return [...this.#entries.values()].map((e) => ({
      session_id: e.record.session_id,
      session_name: e.record.session_name,
      role: e.record.role,
      status: e.status,
      ...(e.error ? { error: e.error } : {}),
    }));
  }

  events(sessionId: SessionId): SequencedEvent[] | undefined {
    return this.#entries.get(sessionId)?.events.slice();
  }

  async say(sessionId: SessionId, text: string) {
    const events = this.#entries.get(sessionId)?.events ?? [];
    return this.append(sessionId, {
      type: 'message.created',
      payload: messageWithMentions(events, text),
    });
  }

  /** Appends an event the owner created in the UI. Never called from remote input. */
  async append(
    sessionId: SessionId,
    event: { type: string; payload: Record<string, unknown>; reply_to?: string },
  ) {
    const client = this.#entries.get(sessionId)?.client;
    if (!client) return undefined;
    return client.append(event);
  }

  /** Called with each live request addressed to this device's owner (for notifications). */
  onRequestForMe(listener: (sessionName: string, event: SequencedEvent) => void): () => void {
    return this.subscribe((update) => {
      if (update.type !== 'event') return;
      const { type, payload, actor_user_id: author } = update.event;
      const me = this.#identity.userId;
      // Requests addressed to me, and messages that mention me or my agent (not my own).
      const forMe =
        (type === 'request.created' && ((payload.to ?? []) as string[]).includes(me)) ||
        (type === 'message.created' &&
          author !== me &&
          (((payload.mentions ?? []) as string[]).includes(me) ||
            ((payload.agent_mentions ?? []) as { user: string }[]).some((m) => m.user === me)));
      if (!forMe) return;
      const entry = this.#entries.get(update.session_id);
      // Only events that arrive after the initial history load count as new.
      if (entry && entry.status === 'online') listener(entry.record.session_name, update.event);
    });
  }

  subscribe(listener: (update: HubUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      [...this.#entries.values()].map(async (entry) => {
        if (!entry.client) return;
        // Best effort: tell the session we are leaving, without delaying shutdown for long.
        await Promise.race([
          entry.client
            .append({ type: 'presence.changed', payload: { state: 'offline' } })
            .catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 1000).unref()),
        ]);
        await entry.client.stop();
      }),
    );
  }

  #onEvent(entry: Entry, event: SequencedEvent): void {
    entry.events.push(event);
    if (entry.events.length > MAX_EVENTS_PER_SESSION) entry.events.shift();
    this.#emit({ type: 'event', session_id: entry.record.session_id, event });
  }

  #onStatus(entry: Entry, status: ClientStatus, error?: ClientError): void {
    this.#setStatus(entry, status, error?.message);
    // Announce on every (re)connect: the host may have restarted, or others saw us go offline.
    if (status !== 'online') entry.announced = false;
    else if (!entry.announced) {
      entry.announced = true;
      entry.client
        ?.append({ type: 'presence.changed', payload: this.#onlinePresence() })
        .catch(() => undefined);
    }
  }

  // Read on every announcement, so a later `pearcoder attach` shows after the next reconnect.
  #onlinePresence(): { state: 'online'; agents?: AgentHarness[] } {
    const agents = readAttachedAgents(this.#home);
    this.#announcedAgents = JSON.stringify(agents);
    return agents.length ? { state: 'online', agents } : { state: 'online' };
  }

  #setStatus(entry: Entry, status: SessionView['status'], error?: string): void {
    entry.status = status;
    if (error) entry.error = error;
    else delete entry.error;
    this.#emit({
      type: 'status',
      session_id: entry.record.session_id,
      status,
      ...(error ? { error } : {}),
    });
  }

  #emit(update: HubUpdate): void {
    for (const listener of this.#listeners) {
      try {
        listener(update);
      } catch {
        // One broken browser tab must not affect the others.
      }
    }
  }
}
