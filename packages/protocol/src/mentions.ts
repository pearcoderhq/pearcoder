import type { AgentHarness } from './events.js';

export const AGENT_LABELS: Record<AgentHarness, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

const WORD = /[\p{L}\p{N}_]/u;

export interface MentionCandidate {
  /** What follows the `@`, e.g. `Alice` or `Alice's Claude Code`. */
  label: string;
  user: string;
  agent?: AgentHarness;
}

/** Everyone and every attached agent that can be mentioned in a session. */
export function mentionCandidates(
  people: { user: string; name: string; agents?: readonly AgentHarness[] }[],
): MentionCandidate[] {
  return people.flatMap((p) => [
    { label: p.name, user: p.user },
    ...(p.agents ?? []).map((agent) => ({
      label: `${p.name}'s ${AGENT_LABELS[agent]}`,
      user: p.user,
      agent,
    })),
  ]);
}

/**
 * The people and agents a message mentions with `@label`. Longer labels win, so
 * `@Alice's Claude Code` mentions the agent, not Alice. Case-insensitive; the `@` must start a
 * word and the label must end at a word boundary.
 */
export function findMentions(
  text: string,
  candidates: MentionCandidate[],
): { mentions: string[]; agent_mentions: { user: string; agent: AgentHarness }[] } {
  const sorted = [...candidates].sort((a, b) => b.label.length - a.label.length);
  const lower = text.toLowerCase();
  const mentions = new Set<string>();
  const agents = new Map<string, { user: string; agent: AgentHarness }>();
  for (let i = lower.indexOf('@'); i !== -1; i = lower.indexOf('@', i + 1)) {
    // `x@Alice.dev` is an address, not a mention: the `@` must start a word.
    if (i > 0 && WORD.test(lower.charAt(i - 1))) continue;
    const rest = lower.slice(i + 1);
    const hit = sorted.find((c) => {
      const label = c.label.toLowerCase();
      return rest.startsWith(label) && !WORD.test(rest.charAt(label.length));
    });
    if (!hit) continue;
    if (hit.agent) agents.set(`${hit.user}:${hit.agent}`, { user: hit.user, agent: hit.agent });
    else mentions.add(hit.user);
  }
  return { mentions: [...mentions], agent_mentions: [...agents.values()] };
}
