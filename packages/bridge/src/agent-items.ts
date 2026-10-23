import {
  inboxOf,
  mentionsOf,
  participantsOf,
  type RequestView,
  type TaskView,
  tasksOf,
} from '@pearcoderhq/client';
import type { DeviceIdentity } from '@pearcoderhq/core';
import { type SequencedEvent, verifyEventSignature } from '@pearcoderhq/protocol';
import { approvalOf, isAuto } from './policy.js';

/** Something in a session aimed at the owner's agent: a mention, a request or a task. */
export interface AgentItem {
  id: string;
  session_id: string;
  kind: 'mention' | 'request' | 'task';
  from: string;
  from_name: string;
  /** Written by someone's agent. Agents never answer agents (docs/invariants.md, invariant 7). */
  by_agent: boolean;
  /**
   * Written by this owner: signed by this device's own key, without agent attribution. Checked
   * here, not taken from the host, so a host can't pass someone else's text off as the owner's.
   */
  by_owner: boolean;
  /** What the item says, as its author wrote it. */
  text: string;
  request?: RequestView;
  task?: TaskView;
  at: string;
}

/**
 * Whether the agent may handle an item: on its own under the session's auto mode, after the
 * owner approved it (as is, or edited), or not (still waiting, or declined).
 */
export type ItemGate = 'auto' | 'approved' | 'edited' | 'waiting' | 'declined';

export function signedByOwner(
  event: SequencedEvent | undefined,
  identity: DeviceIdentity,
): boolean {
  return Boolean(
    event &&
      event.actor_user_id === identity.userId &&
      !event.actor_agent_id &&
      verifyEventSignature(event, identity.publicKeyObject),
  );
}

export function agentItems(
  sessionId: string,
  events: SequencedEvent[],
  identity: DeviceIdentity,
): AgentItem[] {
  const me = identity.userId;
  const byId = new Map(events.map((e) => [e.id, e]));
  const names = new Map(participantsOf(events).map((p) => [p.user_id, p.display_name]));
  const items: AgentItem[] = [];
  for (const m of mentionsOf(events, me)) {
    if (!m.agent) continue;
    items.push({
      id: m.id,
      session_id: sessionId,
      kind: 'mention',
      from: m.from,
      from_name: m.from_name,
      by_agent: m.by_agent,
      by_owner: signedByOwner(byId.get(m.id), identity),
      text: m.text,
      at: m.at,
    });
  }
  for (const r of inboxOf(events, me)) {
    items.push({
      id: r.id,
      session_id: sessionId,
      kind: 'request',
      from: r.from,
      from_name: r.from_name,
      by_agent: Boolean(byId.get(r.id)?.actor_agent_id),
      by_owner: signedByOwner(byId.get(r.id), identity),
      text: [`${r.kind}: ${r.title}`, r.body ?? ''].filter(Boolean).join('\n'),
      request: r,
      at: r.created_at,
    });
  }
  for (const t of tasksOf(events)) {
    if (t.status === 'done' || t.assignee?.user !== me || !t.assignee.agent) continue;
    // Whoever made the current assignment is who asked the agent, not who first wrote the task.
    const assigned = byId.get(t.assigned_by_event);
    const from = assigned?.actor_user_id ?? t.from;
    items.push({
      id: t.id,
      session_id: sessionId,
      kind: 'task',
      from,
      from_name: names.get(from) ?? from,
      by_agent: Boolean(assigned?.actor_agent_id),
      by_owner:
        signedByOwner(assigned, identity) &&
        (assigned?.id === t.id || signedByOwner(byId.get(t.id), identity)),
      text: [t.title, t.body ?? ''].filter(Boolean).join('\n\n'),
      task: t,
      at: t.created_at,
    });
  }
  return items;
}

export function gateOf(home: string, item: AgentItem): ItemGate {
  const approval = approvalOf(home, item.session_id, item.id);
  if (approval?.declined) return 'declined';
  if (approval?.text) return 'edited';
  if (approval) return 'approved';
  return isAuto(home, item.session_id, item.by_owner ? 'mine' : 'others') ? 'auto' : 'waiting';
}

/**
 * The owner's own words for this item, if there are any: what they wrote themselves, or their
 * edited version of someone else's item. Only these may start code changes (ADR-0007).
 */
export function ownerTextOf(home: string, item: AgentItem): string | undefined {
  const approval = approvalOf(home, item.session_id, item.id);
  if (approval?.declined) return undefined;
  if (approval?.text) return approval.text;
  return item.by_owner ? item.text : undefined;
}
