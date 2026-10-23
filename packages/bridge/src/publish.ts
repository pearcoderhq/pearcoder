import { createHash } from 'node:crypto';
import { listRecords, resolveEndpoint, SessionClient } from '@pearcoderhq/client';
import { type DeviceIdentity, redactValue, type SecretFinding, scanValue } from '@pearcoderhq/core';
import type { AgentId } from '@pearcoderhq/protocol';
import { type Draft, DraftError, getDraft, markPublished } from './drafts.js';

/** Stable attribution id for "this owner's agent in this harness"; never a signing identity. */
export function agentIdFor(userId: string, harness: string): AgentId {
  return `a_${createHash('sha256').update(`${userId}:${harness}`).digest('base64url').slice(0, 16)}`;
}

export class PublishBlockedError extends Error {
  readonly code = 'SECRETS_FOUND';
  constructor(readonly findings: SecretFinding[]) {
    super('the draft looks like it contains secrets or private details');
  }
}

export interface PublishOptions {
  /** Replace findings with `[redacted …]` markers before publishing. */
  redact?: boolean;
  /** Publish even though the scan found something (the owner checked it). */
  allowSecrets?: boolean;
}

/**
 * The only path from a private draft to the session (docs/invariants.md, invariant 3). Runs on the owner's explicit
 * action in the CLI or UI, scans for secrets first, and signs as the owner with the agent attributed.
 */
export async function publishDraft(
  home: string,
  identity: DeviceIdentity,
  draftId: string,
  options: PublishOptions = {},
): Promise<{ draft: Draft; eventId: string; sequence: number }> {
  const draft = getDraft(home, draftId);
  if (draft.status !== 'draft') {
    throw new DraftError('DRAFT_NOT_EDITABLE', `draft is already ${draft.status}`);
  }
  let payload = draft.payload;
  const findings = scanValue(payload);
  if (findings.length > 0) {
    if (options.redact) payload = redactValue(payload);
    else if (!options.allowSecrets) throw new PublishBlockedError(findings);
  }
  const record = listRecords(home).find((r) => r.session_id === draft.session_id);
  if (!record) throw new Error('you are no longer in the session this draft belongs to');
  const client = new SessionClient({
    host: record,
    endpoint: await resolveEndpoint(record),
    identity,
  });
  const attribution = draft.source.via === 'mcp' && {
    actor_agent_id: agentIdFor(identity.userId, draft.source.harness ?? 'mcp'),
  };
  const outcome =
    draft.kind === 'finding'
      ? await client.append({ type: 'review.finding', payload, ...attribution })
      : await client.append({
          type: 'message.created',
          payload: { text: (payload as { text: string }).text },
          reply_to: (payload as { reply_to: string }).reply_to,
          ...attribution,
        });
  return {
    draft: markPublished(home, draft.id, outcome.id),
    eventId: outcome.id,
    sequence: outcome.sequence,
  };
}
