import {
  type AgentHarness,
  AgentHarnessSchema,
  findMentions,
  type MentionCandidate,
  mentionCandidates,
  type SequencedEvent,
} from '@pearcoderhq/protocol';

// Read models derived from a session's event log, shared by the CLI, MCP server and local node.

export interface ParticipantView {
  user_id: string;
  display_name: string;
  role: string;
  active: boolean;
}

export interface RequestView {
  id: string;
  from: string;
  from_name: string;
  to: string[];
  kind: string;
  title: string;
  body?: string;
  context_package?: string;
  /** The requester would like the addressees to use this agent of theirs (informational). */
  for_agent?: string;
  created_at: string;
  /** Resolutions by user id (the requester's or an addressee's). */
  resolutions: Record<string, string>;
}

export interface PackageView {
  id: string;
  author: string;
  title: string;
  objective: string;
  version: number;
  hash: string;
  created_at: string;
}

export function participantsOf(events: SequencedEvent[]): ParticipantView[] {
  const people = new Map<string, ParticipantView>();
  for (const event of events) {
    if (event.type === 'participant.joined') {
      people.set(event.actor_user_id, {
        user_id: event.actor_user_id,
        display_name: String(event.payload.display_name),
        role: String(event.payload.role),
        active: true,
      });
    } else if (event.type === 'participant.left') {
      const person = people.get(event.actor_user_id);
      if (person) person.active = false;
    }
  }
  return [...people.values()];
}

export function requestsOf(events: SequencedEvent[]): RequestView[] {
  const names = new Map(participantsOf(events).map((p) => [p.user_id, p.display_name]));
  const requests = new Map<string, RequestView>();
  for (const event of events) {
    if (event.type === 'request.created') {
      const p = event.payload;
      requests.set(event.id, {
        id: event.id,
        from: event.actor_user_id,
        from_name: names.get(event.actor_user_id) ?? event.actor_user_id,
        to: (p.to as string[]) ?? [],
        kind: String(p.kind),
        title: String(p.title),
        ...(typeof p.body === 'string' && { body: p.body }),
        ...(typeof p.context_package === 'string' && { context_package: p.context_package }),
        ...(typeof p.for_agent === 'string' && { for_agent: p.for_agent }),
        created_at: event.received_at,
        resolutions: {},
      });
    } else if (event.type === 'request.resolved') {
      const request = requests.get(String(event.payload.request));
      if (request) request.resolutions[event.actor_user_id] = String(event.payload.resolution);
    }
  }
  return [...requests.values()];
}

/** Requests addressed to `userId` that this user has not resolved yet. */
export function inboxOf(events: SequencedEvent[], userId: string): RequestView[] {
  return requestsOf(events).filter((r) => r.to.includes(userId) && !r.resolutions[userId]);
}

export function packagesOf(events: SequencedEvent[]): PackageView[] {
  return events
    .filter((e) => e.type === 'context_package.published')
    .map((e) => ({
      id: e.id,
      author: e.actor_user_id,
      title: String(e.payload.title),
      objective: String(e.payload.objective),
      version: Number(e.payload.version ?? 1),
      hash: String(e.payload.hash),
      created_at: e.received_at,
    }));
}

/** Finds participants by display name (case-insensitive) or user id. */
export function findParticipants(events: SequencedEvent[], names: string[]): ParticipantView[] {
  const people = participantsOf(events).filter((p) => p.active);
  return names.map((name) => {
    const wanted = name.toLowerCase();
    const matches = people.filter(
      (p) => p.user_id === name || p.display_name.toLowerCase() === wanted,
    );
    if (matches.length !== 1 || !matches[0]) {
      throw new Error(
        matches.length === 0
          ? `nobody named ${name} is in this session`
          : `several people are named ${name}; use their user id`,
      );
    }
    return matches[0];
  });
}

/** Who can be mentioned: active people, plus the agents they last announced. */
export function mentionCandidatesOf(events: SequencedEvent[]): MentionCandidate[] {
  const agents = new Map<string, AgentHarness[]>();
  for (const e of events) {
    if (e.type !== 'presence.changed' || !Array.isArray(e.payload.agents)) continue;
    agents.set(
      e.actor_user_id,
      e.payload.agents.filter((a): a is AgentHarness => AgentHarnessSchema.safeParse(a).success),
    );
  }
  return mentionCandidates(
    participantsOf(events)
      .filter((p) => p.active)
      .map((p) => ({ user: p.user_id, name: p.display_name, agents: agents.get(p.user_id) ?? [] })),
  );
}

/** A message payload with the `@` mentions found in its text. */
export function messageWithMentions(
  events: SequencedEvent[],
  text: string,
): Record<string, unknown> {
  const { mentions, agent_mentions } = findMentions(text, mentionCandidatesOf(events));
  return {
    text,
    ...(mentions.length && { mentions }),
    ...(agent_mentions.length && { agent_mentions }),
  };
}

export interface MentionView {
  id: string;
  from: string;
  from_name: string;
  text: string;
  /** Set when the message mentions this person's agent rather than the person. */
  agent?: AgentHarness;
  /** The message was drafted by its author's agent (published by the author). */
  by_agent: boolean;
  at: string;
}

/** Messages that mention `userId` or their agent and that they have not replied to. */
export function mentionsOf(events: SequencedEvent[], userId: string): MentionView[] {
  const names = new Map(participantsOf(events).map((p) => [p.user_id, p.display_name]));
  const replied = new Set(
    events.filter((e) => e.actor_user_id === userId && e.reply_to).map((e) => e.reply_to),
  );
  const out: MentionView[] = [];
  for (const e of events) {
    if (e.type !== 'message.created' || replied.has(e.id)) continue;
    const own = e.actor_user_id === userId;
    // You don't mention yourself, but you do ask your own agent for things.
    const people = own ? [] : ((e.payload.mentions ?? []) as string[]);
    const agent = (
      (e.payload.agent_mentions ?? []) as { user: string; agent: AgentHarness }[]
    ).find((m) => m.user === userId);
    if (own && e.actor_agent_id) continue;
    if (!people.includes(userId) && !agent) continue;
    out.push({
      id: e.id,
      from: e.actor_user_id,
      from_name: names.get(e.actor_user_id) ?? e.actor_user_id,
      text: String(e.payload.text),
      ...(agent && { agent: agent.agent }),
      by_agent: Boolean(e.actor_agent_id),
      at: e.received_at,
    });
  }
  return out;
}
