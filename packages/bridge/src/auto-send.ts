import type { DeviceIdentity } from '@pearcoderhq/core';
import { draftTitle, listDrafts } from './drafts.js';
import { autoSince, isAuto } from './policy.js';
import { PublishBlockedError, publishDraft } from './publish.js';

/** At most this many drafts per session go out on their own in an hour (docs/invariants.md, 7). */
export const AUTO_SEND_PER_HOUR = 10;
const POLL_MS = 3000;

export interface AutoSendOptions {
  home: string;
  identity: DeviceIdentity;
  /** Drafts older than this (or than when auto was last switched on) are never sent on their own. */
  startedAt: Date;
  onSent?: (title: string, sessionId: string) => void;
  onHeld?: (title: string, sessionId: string, reason: string) => void;
  now?: () => number;
}

/**
 * Sends the owner's agent drafts for sessions where the owner left "auto" on (ADR-0006). This runs
 * in the owner's local node under the owner's own setting; the agent still has no way to publish.
 * The secret scan always runs: a draft that trips it stays a draft and the owner is told.
 */
export function startAutoSend(options: AutoSendOptions): {
  stop: () => void;
  tick: () => Promise<void>;
} {
  const now = options.now ?? Date.now;
  const sent = new Map<string, number[]>();
  const held = new Set<string>();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const draft of listDrafts(options.home, { status: 'draft' })) {
        if (draft.source.via !== 'mcp' || held.has(draft.id)) continue;
        if (!isAuto(options.home, draft.session_id)) continue;
        const since = Math.max(
          options.startedAt.getTime(),
          Date.parse(autoSince(options.home, draft.session_id) ?? '1970-01-01T00:00:00Z'),
        );
        if (Date.parse(draft.created_at) < since) continue;
        const recent = (sent.get(draft.session_id) ?? []).filter((t) => now() - t < 3_600_000);
        if (recent.length >= AUTO_SEND_PER_HOUR) {
          held.add(draft.id);
          options.onHeld?.(draftTitle(draft), draft.session_id, 'hourly auto-send limit reached');
          continue;
        }
        try {
          await publishDraft(options.home, options.identity, draft.id);
          sent.set(draft.session_id, [...recent, now()]);
          options.onSent?.(draftTitle(draft), draft.session_id);
        } catch (error) {
          held.add(draft.id);
          options.onHeld?.(
            draftTitle(draft),
            draft.session_id,
            error instanceof PublishBlockedError
              ? 'it may contain a secret'
              : (error as Error).message,
          );
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
