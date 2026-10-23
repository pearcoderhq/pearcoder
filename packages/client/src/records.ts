import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type SessionId, SessionIdSchema, UserIdSchema } from '@pearcoderhq/protocol';
import { z } from 'zod';

// What this device remembers about each session it hosts or has joined.
export const SessionRecordSchema = z.object({
  v: z.literal(1),
  session_id: SessionIdSchema,
  session_name: z.string().min(1).max(80),
  host_user_id: UserIdSchema,
  host_public_key: z.base64url(),
  role: z.enum(['host', 'member', 'observer']),
  addresses: z.array(z.url()).min(1),
  tls_fingerprint: z.string().optional(),
  joined_at: z.iso.datetime(),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

function dir(home: string, sessionId: SessionId): string {
  if (!SessionIdSchema.safeParse(sessionId).success) throw new Error('invalid session id');
  return join(home, 'sessions', sessionId);
}

export function writeRecord(home: string, record: SessionRecord): void {
  const target = dir(home, record.session_id);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const file = join(target, 'session.json');
  writeFileSync(`${file}.tmp`, `${JSON.stringify(SessionRecordSchema.parse(record), null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(`${file}.tmp`, file);
}

/** Forgets a session on this device: its record and cursor. Nothing is sent to the host. */
export function removeRecord(home: string, sessionId: SessionId): void {
  rmSync(dir(home, sessionId), { recursive: true, force: true });
}

export function listRecords(home: string): SessionRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(join(home, 'sessions'));
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const entry of entries) {
    if (!SessionIdSchema.safeParse(entry).success) continue;
    try {
      const raw = JSON.parse(readFileSync(join(home, 'sessions', entry, 'session.json'), 'utf8'));
      const parsed = SessionRecordSchema.safeParse(raw);
      if (parsed.success) records.push(parsed.data);
    } catch {
      // Sessions with only a cursor (or a damaged record) are skipped.
    }
  }
  return records.sort((a, b) => b.joined_at.localeCompare(a.joined_at));
}
