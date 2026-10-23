import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type SessionId, SessionIdSchema } from '@pearcoderhq/protocol';

/** The last sequence this node has processed per session, so it resumes without gaps. */
export interface CursorStore {
  get(sessionId: SessionId): number;
  set(sessionId: SessionId, sequence: number): void;
}

export class MemoryCursorStore implements CursorStore {
  readonly #cursors = new Map<SessionId, number>();
  get(sessionId: SessionId): number {
    return this.#cursors.get(sessionId) ?? 0;
  }
  set(sessionId: SessionId, sequence: number): void {
    this.#cursors.set(sessionId, sequence);
  }
}

/** Stores cursors in `<home>/sessions/<session_id>/cursor`, written atomically. */
export class FileCursorStore implements CursorStore {
  readonly #home: string;
  constructor(home: string) {
    this.#home = home;
  }

  get(sessionId: SessionId): number {
    try {
      const value = Number(readFileSync(this.#file(sessionId), 'utf8').trim());
      return Number.isInteger(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  set(sessionId: SessionId, sequence: number): void {
    const file = this.#file(sessionId);
    mkdirSync(join(this.#home, 'sessions', sessionId), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, `${sequence}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  #file(sessionId: SessionId): string {
    // Validated, not just typed: the id becomes a path segment (threat model T18).
    if (!SessionIdSchema.safeParse(sessionId).success) throw new Error('invalid session id');
    return join(this.#home, 'sessions', sessionId, 'cursor');
  }
}
