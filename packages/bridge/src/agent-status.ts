import { type DeviceIdentity, readAttachedAgents } from '@pearcoderhq/core';
import type { AgentHarness, SessionId } from '@pearcoderhq/protocol';
import { agentItems, gateOf } from './agent-items.js';
import type { SessionHub } from './hub.js';
import { approvalOf, sharesStatus } from './policy.js';
import { activeRuns, claimedItems, claimOf } from './runs.js';

const POLL_MS = 3000;

type State = 'idle' | 'listening' | 'waiting_owner' | 'approved' | 'working' | 'done' | 'declined';

/**
 * Publishes what the owner's agent is doing (`activity.changed`, ADR-0007) so people who message it
 * see that it is waiting for its owner, working, or done. Only states and item ids: never
 * prompts, tool calls or output. Publishes on change only, and not at all in sessions where the
 * owner turned sharing off.
 */
export function startAgentStatus(options: {
  home: string;
  identity: DeviceIdentity;
  hub: SessionHub;
  now?: () => number;
}): { stop: () => void; tick: () => Promise<void> } {
  const now = options.now ?? Date.now;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const harness: AgentHarness | undefined = readAttachedAgents(options.home)[0];
      if (!harness) return;
      for (const session of options.hub.sessions()) {
        if (session.status !== 'online' || !sharesStatus(options.home, session.session_id))
          continue;
        await publishChanges(session.session_id, harness);
      }
    } finally {
      running = false;
    }
  };

  const publishChanges = async (sessionId: SessionId, harness: AgentHarness) => {
    const events = options.hub.events(sessionId) ?? [];
    const me = options.identity.userId;
    // What this owner last published, per item and overall, read back from the log so a
    // restart does not repeat it.
    const last = new Map<string, State>();
    let overall: State = 'idle';
    for (const e of events) {
      if (e.type !== 'activity.changed' || e.actor_user_id !== me) continue;
      const state = e.payload.state as State;
      if (typeof e.payload.item === 'string') last.set(e.payload.item, state);
      else overall = state;
    }
    const send = (payload: Record<string, unknown>) =>
      options.hub.append(sessionId, {
        type: 'activity.changed',
        payload: { agent: harness, ...payload },
      });

    const open = new Set<string>();
    const handled = claimedItems(options.home);
    for (const item of agentItems(sessionId, events, options.identity)) {
      if (item.by_agent) continue;
      const claim = claimOf(options.home, sessionId, item.id, now());
      // A run already took it and moved on: it is done, even if its draft is not sent yet.
      if (!claim && handled.has(`${sessionId}:${item.id}`)) continue;
      const gate = gateOf(options.home, item);
      const state: State | undefined = claim
        ? 'working'
        : gate === 'declined'
          ? 'declined'
          : gate === 'waiting'
            ? 'waiting_owner'
            : gate === 'approved' || gate === 'edited'
              ? 'approved'
              : undefined;
      if (!state) continue;
      open.add(item.id);
      if (last.get(item.id) === state) continue;
      const edited =
        (state === 'working' || state === 'approved') &&
        Boolean(approvalOf(options.home, sessionId, item.id)?.text);
      await send({ state, item: item.id, ...(edited && { edited: true }) });
    }
    // Work that was in progress and no longer is has finished (answered, pushed or stopped).
    for (const [item, state] of last) {
      if (state === 'working' && !open.has(item)) await send({ state: 'done', item });
    }
    const listening = activeRuns(options.home, now()).length > 0 ? 'listening' : 'idle';
    if (listening !== overall) await send({ state: listening });
  };

  const timer = setInterval(() => void tick().catch(() => undefined), POLL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
