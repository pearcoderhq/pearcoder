import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type SequencedEvent,
  SequencedEventSchema,
  type SessionId,
  SessionIdSchema,
} from '@pearcoderhq/protocol';
import type { InvitationPersistence, InvitationRecord } from './invitations.js';
import type { EventStore } from './store.js';

// Loaded on first use: node:sqlite prints an experimental warning when it loads, and most
// commands never open a store.
const sqlite = () => createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

// Forward-only migrations (docs/invariants.md, engineering rules). Each entry runs once, in order, inside a transaction.
const MIGRATIONS = [
  `create table meta (key text primary key, value text not null);
   create table events (sequence integer primary key, id text not null unique, json text not null);
   create table invitations (invite_id text primary key, json text not null);`,
];

/**
 * Durable host storage for one session (`--persist`): the event log plus outstanding
 * invitations, in `<home>/hosted/<session_id>/session.db` inside a 0700 directory.
 */
export class SqliteSessionStore implements EventStore, InvitationPersistence {
  readonly #db: DatabaseSync;

  constructor(readonly path: string) {
    this.#db = new (sqlite().DatabaseSync)(path);
    this.#db.exec(
      'pragma journal_mode = wal; pragma synchronous = full; pragma foreign_keys = on;',
    );
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec('create table if not exists schema_version (version integer not null)');
    const row = this.#db.prepare('select max(version) as v from schema_version').get() as {
      v: number | null;
    };
    for (let version = (row.v ?? 0) + 1; version <= MIGRATIONS.length; version++) {
      this.#db.exec('begin');
      try {
        this.#db.exec(MIGRATIONS[version - 1] as string);
        this.#db.prepare('insert into schema_version (version) values (?)').run(version);
        this.#db.exec('commit');
      } catch (error) {
        this.#db.exec('rollback');
        throw error;
      }
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.#db.prepare('select value from meta where key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        'insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
      )
      .run(key, value);
  }

  head(): number {
    const row = this.#db.prepare('select max(sequence) as head from events').get() as {
      head: number | null;
    };
    return row.head ?? 0;
  }

  get(id: string): SequencedEvent | undefined {
    const row = this.#db.prepare('select json from events where id = ?').get(id) as
      | { json: string }
      | undefined;
    return row ? SequencedEventSchema.parse(JSON.parse(row.json)) : undefined;
  }

  append(event: SequencedEvent): void {
    const expected = this.head() + 1;
    if (event.sequence !== expected)
      throw new Error(`store expected sequence ${expected}, got ${event.sequence}`);
    this.#db
      .prepare('insert into events (sequence, id, json) values (?, ?, ?)')
      .run(event.sequence, event.id, JSON.stringify(event));
  }

  after(sequence: number, limit: number): SequencedEvent[] {
    const rows = this.#db
      .prepare('select json from events where sequence > ? order by sequence limit ?')
      .all(Math.max(0, Math.floor(sequence)), Math.max(0, limit)) as { json: string }[];
    return rows.map((r) => SequencedEventSchema.parse(JSON.parse(r.json)));
  }

  loadInvitations(): InvitationRecord[] {
    const rows = this.#db.prepare('select json from invitations').all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as InvitationRecord);
  }

  saveInvitation(record: InvitationRecord): void {
    this.#db
      .prepare(
        'insert into invitations (invite_id, json) values (?, ?) on conflict(invite_id) do update set json = excluded.json',
      )
      .run(record.invitation.invite_id, JSON.stringify(record));
  }

  close(): void {
    this.#db.close();
  }
}

export function hostedDir(home: string, sessionId: SessionId): string {
  if (!SessionIdSchema.safeParse(sessionId).success) throw new Error('invalid session id');
  return join(home, 'hosted', sessionId);
}

/** Opens (creating if needed) the store for a session this device hosts persistently. */
export function openSessionStore(home: string, sessionId: SessionId): SqliteSessionStore {
  const dir = hostedDir(home, sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The database inherits the umask; the 0700 directory keeps other users out (threat model T17).
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  return new SqliteSessionStore(join(dir, 'session.db'));
}

export class SessionBusyError extends Error {
  constructor(readonly pid: number) {
    super(`this session is already being hosted (process ${pid})`);
    this.name = 'SessionBusyError';
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Takes the single-host lock for a persisted session, so two processes never append to the same
 * history. A lock left by a process that has died is taken over. Returns the release function.
 */
export function lockHostedSession(home: string, sessionId: SessionId): () => void {
  const file = join(hostedDir(home, sessionId), 'host.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file);
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(file, 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
        throw new SessionBusyError(pid);
      }
      unlinkSync(file);
    }
  }
  throw new Error('could not take the host lock');
}

export interface HostedSessionInfo {
  sessionId: SessionId;
  sessionName: string;
  path: string;
}

/** Sessions this device has hosted with `--persist`. */
export function listHostedSessions(home: string): HostedSessionInfo[] {
  const root = join(home, 'hosted');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(
      (id) => SessionIdSchema.safeParse(id).success && existsSync(join(root, id, 'session.db')),
    )
    .map((id) => {
      const store = new SqliteSessionStore(join(root, id, 'session.db'));
      try {
        return {
          sessionId: id as SessionId,
          sessionName: store.getMeta('session_name') ?? id,
          path: store.path,
        };
      } finally {
        store.close();
      }
    });
}
