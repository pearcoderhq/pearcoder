import {
  findMentions,
  type MentionCandidate,
  mentionCandidates,
} from '@pearcoderhq/protocol/mentions';
import type { WireEvent } from './api';

export interface Person {
  userId: string;
  name: string;
  role: 'host' | 'member' | 'observer';
  active: boolean;
  presence: string;
  /** Agents this person attached (`pearcoder attach`), from their last announcement. */
  agents: string[];
}

export const AGENT_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
export const agentLabel = (harness: string) => AGENT_LABEL[harness] ?? harness;

/** Inserts events by sequence, ignoring duplicates (snapshot and live stream overlap). */
export function mergeEvents(current: WireEvent[], incoming: WireEvent[]): WireEvent[] {
  const bySequence = new Map(current.map((e) => [e.sequence, e]));
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

/**
 * Who is in the session, derived from the event log. Joining is not being online: a person shows
 * online only after their client announces it. `self` is this device's own live connection, which
 * is more current than its last announcement.
 */
export function participants(
  events: WireEvent[],
  self?: { userId: string; online: boolean },
): Person[] {
  const people = new Map<string, Person>();
  for (const event of events) {
    if (event.type === 'participant.joined') {
      people.set(event.actor_user_id, {
        userId: event.actor_user_id,
        name: String(event.payload.display_name ?? 'Someone'),
        role: (event.payload.role as Person['role']) ?? 'member',
        active: true,
        presence: 'joined',
        agents: [],
      });
    }
    const person = people.get(event.actor_user_id);
    if (!person) continue;
    if (event.type === 'participant.left') {
      person.active = false;
      person.presence = 'offline';
    } else if (event.type === 'presence.changed') {
      person.presence = String(event.payload.state);
      if (Array.isArray(event.payload.agents)) {
        person.agents = event.payload.agents.filter((a): a is string => typeof a === 'string');
      }
    }
  }
  const me = self && people.get(self.userId);
  if (self && me?.active) me.presence = self.online ? 'online' : 'offline';
  return [...people.values()];
}

export function isOnline(person: Person): boolean {
  return person.active && person.presence !== 'offline' && person.presence !== 'joined';
}

export function presenceLabel(person: Person): string {
  if (!person.active) return 'left';
  if (person.presence === 'joined') return 'joined, not seen online yet';
  return isOnline(person) ? 'online' : 'offline';
}

/** Who can be mentioned with `@` in this session: active people and their attached agents. */
export function candidatesFor(people: Person[]): MentionCandidate[] {
  return mentionCandidates(
    people
      .filter((p) => p.active)
      .map((p) => ({
        user: p.userId,
        name: p.name,
        agents: p.agents.filter((a): a is 'claude-code' | 'codex' => a in AGENT_LABEL),
      })),
  );
}

// Words that open a request for work. Deliberately short: a missed hint costs nothing, a hint on
// every chat message would be noise.
const TASK_START =
  /^(?:(?:please|pls|can you|could you|would you)\s+)?(?:add|build|bump|change|check|clean|create|delete|document|explain|find|fix|implement|investigate|look|make|migrate|move|refactor|remove|rename|replace|review|rewrite|run|split|test|update|upgrade|write)\b/i;

/**
 * Whether a message reads like work for an agent but mentions nobody, so no agent's inbox gets
 * it. Only used to hint the owner about their own message; it never addresses anyone by itself.
 */
export function looksLikeAgentTask(text: string, candidates: MentionCandidate[]): boolean {
  const value = text.trim();
  if (value.length < 8) return false;
  const { mentions, agent_mentions } = findMentions(value, candidates);
  if (mentions.length || agent_mentions.length) return false;
  return TASK_START.test(value) || /^(?:please|pls|can you|could you)\b/i.test(value);
}

/** Messages mentioning `me` or my agent that I have not replied to. */
export function openMentionsFor(events: WireEvent[], me: string | undefined): WireEvent[] {
  if (!me) return [];
  const replied = new Set(
    events.filter((e) => e.actor_user_id === me && e.reply_to).map((e) => e.reply_to),
  );
  return events.filter(
    (e) =>
      e.type === 'message.created' &&
      e.actor_user_id !== me &&
      !replied.has(e.id) &&
      (((e.payload.mentions as string[] | undefined) ?? []).includes(me) ||
        mentionedAgent(e, me) !== undefined),
  );
}

/** The agent of `me` a message mentions, if any. */
export function mentionedAgent(event: WireEvent, me: string | undefined): string | undefined {
  const list = (event.payload.agent_mentions ?? []) as { user?: string; agent?: string }[];
  return list.find((m) => m.user === me)?.agent;
}

export type AgentState =
  | 'idle'
  | 'listening'
  | 'waiting_owner'
  | 'approved'
  | 'working'
  | 'done'
  | 'declined';

export interface ItemActivity {
  user: string;
  agent: string;
  state: AgentState;
  edited: boolean;
}

/**
 * What each person's agent is doing, from their `activity.changed` events (ADR-0007): the latest
 * state per item they were asked about, and each person's overall state (listening or idle).
 */
export function activityOf(events: WireEvent[]): {
  byItem: Map<string, ItemActivity[]>;
  overall: Map<string, AgentState>;
} {
  const latest = new Map<string, ItemActivity>();
  const overall = new Map<string, AgentState>();
  for (const e of events) {
    if (e.type !== 'activity.changed') continue;
    const state = String(e.payload.state) as AgentState;
    const agent = String(e.payload.agent);
    if (typeof e.payload.item === 'string') {
      latest.set(`${e.payload.item}\u0000${e.actor_user_id}`, {
        user: e.actor_user_id,
        agent,
        state,
        edited: e.payload.edited === true,
      });
    } else {
      overall.set(e.actor_user_id, state);
    }
  }
  const byItem = new Map<string, ItemActivity[]>();
  for (const [key, activity] of latest) {
    const item = key.split('\u0000')[0] ?? '';
    byItem.set(item, [...(byItem.get(item) ?? []), activity]);
  }
  return { byItem, overall };
}

/** Code refs that a later push of the same repository and branch replaced. */
export function supersededRefs(events: WireEvent[]): Map<string, string> {
  const latest = new Map<string, WireEvent>();
  const superseded = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'code_ref.published') continue;
    const repo = e.payload.repo as { name?: string; url?: string } | undefined;
    const key = `${repo?.url ?? repo?.name ?? ''}\u0000${String(e.payload.branch)}`;
    const previous = latest.get(key);
    if (previous && previous.payload.commit !== e.payload.commit) superseded.set(previous.id, e.id);
    latest.set(key, e);
  }
  return superseded;
}
