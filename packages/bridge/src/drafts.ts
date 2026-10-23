import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReviewFindingSchema, SessionIdSchema } from '@pearcoderhq/protocol';
import { z } from 'zod';

// Private drafts written by the owner's agent through MCP. They live only on this machine
// (`<home>/drafts/<session>/<id>.json`, 0600) until the owner publishes one (docs/invariants.md, invariant 3).

/** A reply to a finding, request or message, drafted by the owner's agent (pearcoder-discuss). */
export const ReplyPayloadSchema = z.object({
  text: z.string().trim().min(1).max(16_000),
  reply_to: z.uuid(),
});

const DraftBase = {
  v: z.literal(1),
  id: z.uuid(),
  session_id: SessionIdSchema,
  status: z.enum(['draft', 'published', 'discarded']),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  /** Who wrote it: always this device's owner, through which client and harness. */
  source: z.object({
    via: z.enum(['mcp', 'cli', 'ui']),
    harness: z.string().max(100).optional(),
    agent_id: z.string().optional(),
  }),
  published_event_id: z.uuid().optional(),
};

export const DraftSchema = z.discriminatedUnion('kind', [
  z.object({ ...DraftBase, kind: z.literal('finding'), payload: ReviewFindingSchema }),
  z.object({ ...DraftBase, kind: z.literal('reply'), payload: ReplyPayloadSchema }),
]);

export type Draft = z.infer<typeof DraftSchema>;

export class DraftError extends Error {
  constructor(
    readonly code: 'DRAFT_NOT_FOUND' | 'DRAFT_NOT_EDITABLE' | 'INVALID_DRAFT',
    message: string,
  ) {
    super(message);
  }
}

function sessionDir(home: string, sessionId: string): string {
  if (!SessionIdSchema.safeParse(sessionId).success)
    throw new DraftError('INVALID_DRAFT', 'invalid session id');
  return join(home, 'drafts', sessionId);
}

function write(home: string, draft: Draft): Draft {
  const parsed = DraftSchema.parse(draft);
  const dir = sessionDir(home, parsed.session_id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${parsed.id}.json`);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return parsed;
}

export type DraftKind = Draft['kind'];

/** A short label for lists: the finding title, or the start of a reply. */
export function draftTitle(draft: Draft): string {
  return draft.kind === 'finding'
    ? draft.payload.title
    : `Reply: ${draft.payload.text.slice(0, 80)}`;
}

function payloadSchema(kind: DraftKind) {
  return kind === 'finding' ? ReviewFindingSchema : ReplyPayloadSchema;
}

export function createDraft(
  home: string,
  input: { sessionId: string; kind?: DraftKind; payload: unknown; source: Draft['source'] },
): Draft {
  const kind = input.kind ?? 'finding';
  const payload = payloadSchema(kind).safeParse(input.payload);
  if (!payload.success) {
    throw new DraftError(
      'INVALID_DRAFT',
      payload.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  const now = new Date().toISOString();
  return write(home, {
    v: 1,
    id: randomUUID(),
    session_id: input.sessionId as Draft['session_id'],
    kind,
    status: 'draft',
    created_at: now,
    updated_at: now,
    source: input.source,
    payload: payload.data,
  } as Draft);
}

export function listDrafts(
  home: string,
  filter: { sessionId?: string; status?: Draft['status'] } = {},
): Draft[] {
  const root = join(home, 'drafts');
  let sessions: string[];
  try {
    sessions = filter.sessionId ? [filter.sessionId] : readdirSync(root);
  } catch {
    return [];
  }
  const drafts: Draft[] = [];
  for (const session of sessions) {
    if (!SessionIdSchema.safeParse(session).success) continue;
    let files: string[];
    try {
      files = readdirSync(join(root, session)).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const draft = DraftSchema.parse(
          JSON.parse(readFileSync(join(root, session, file), 'utf8')),
        );
        if (!filter.status || draft.status === filter.status) drafts.push(draft);
      } catch {
        // A damaged draft is skipped rather than breaking the list.
      }
    }
  }
  return drafts.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Finds a draft by full id or unique prefix (at least 6 characters). */
export function getDraft(home: string, idOrPrefix: string): Draft {
  if (idOrPrefix.length < 6)
    throw new DraftError('DRAFT_NOT_FOUND', 'use at least 6 characters of the id');
  const matches = listDrafts(home).filter((d) => d.id.startsWith(idOrPrefix));
  if (matches.length !== 1 || !matches[0]) {
    throw new DraftError(
      'DRAFT_NOT_FOUND',
      matches.length ? 'id prefix is ambiguous' : 'no such draft',
    );
  }
  return matches[0];
}

export function updateDraft(home: string, id: string, payload: unknown): Draft {
  const draft = getDraft(home, id);
  if (draft.status !== 'draft')
    throw new DraftError('DRAFT_NOT_EDITABLE', `draft is ${draft.status}`);
  const parsed = payloadSchema(draft.kind).safeParse(payload);
  if (!parsed.success) throw new DraftError('INVALID_DRAFT', `invalid ${draft.kind}`);
  return write(home, {
    ...draft,
    payload: parsed.data,
    updated_at: new Date().toISOString(),
  } as Draft);
}

export function markPublished(home: string, id: string, eventId: string): Draft {
  const draft = getDraft(home, id);
  return write(home, {
    ...draft,
    status: 'published',
    published_event_id: eventId,
    updated_at: new Date().toISOString(),
  });
}

export function discardDraft(home: string, id: string): Draft {
  const draft = getDraft(home, id);
  if (draft.status !== 'draft')
    throw new DraftError('DRAFT_NOT_EDITABLE', `draft is ${draft.status}`);
  return write(home, { ...draft, status: 'discarded', updated_at: new Date().toISOString() });
}
