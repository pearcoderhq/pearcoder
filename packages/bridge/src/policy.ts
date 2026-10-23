import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BranchNameSchema } from '@pearcoderhq/protocol';
import { z } from 'zod';

/**
 * How the owner's agent may act in each session (ADR-0006, ADR-0007). Kept on the owner's machine
 * only. Two auto modes:
 * - `mine`: the owner's own messages and tasks go straight to their agent, and its answers to them
 *   are sent after the secret scan. On by default.
 * - `others`: the same for everyone else's mentions, requests and tasks. Off by default: each item
 *   waits until the owner approves it, possibly after editing it.
 */
export type AutoMode = 'mine' | 'others';

const SessionPolicySchema = z.object({
  mine: z.boolean().optional(),
  others: z.boolean().optional(),
  /** When each mode was last switched on; only drafts created after it are sent on their own. */
  mine_since: z.iso.datetime().optional(),
  others_since: z.iso.datetime().optional(),
  /** Share what the agent is doing (`activity.changed`) in this session. Defaults to true. */
  share_status: z.boolean().optional(),
});

const ApprovalSchema = z.object({
  at: z.iso.datetime(),
  /** The owner's edited version. When set, the agent reads this instead of the original. */
  text: z.string().trim().min(1).max(16_000).optional(),
  declined: z.literal(true).optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

const PolicySchema = z.object({
  v: z.literal(2),
  /** Defaults for sessions without their own setting. */
  mine: z.boolean(),
  others: z.boolean(),
  sessions: z.record(z.string(), SessionPolicySchema),
  /** The owner's decisions on items aimed at their agent, by session and event id. */
  approvals: z.record(z.string(), z.record(z.string(), ApprovalSchema)),
  /** Branches `git_commit_push` never pushes to, besides the default branch, main and master. */
  protected_branches: z.array(BranchNameSchema).max(100).default([]),
  /** Most files and changed lines one `git_commit_push` may carry. */
  push_limits: z
    .object({
      files: z.number().int().min(1).max(10_000),
      lines: z.number().int().min(1).max(1_000_000),
    })
    .default({ files: 50, lines: 2_000 }),
});
export type AgentPolicy = z.infer<typeof PolicySchema>;

// ADR-0006 files. Their per-session `auto` was about other people's items, so it becomes `others`.
const PolicyV1Schema = z.object({
  v: z.literal(1),
  auto: z.boolean(),
  sessions: z.record(
    z.string(),
    z.object({ auto: z.boolean(), since: z.iso.datetime().optional() }),
  ),
  allowed: z.record(z.string(), z.array(z.string()).max(500)),
});

const FILE = 'agent-policy.json';
const MAX_APPROVALS = 500;
const DEFAULT: AgentPolicy = {
  v: 2,
  mine: true,
  others: false,
  sessions: {},
  approvals: {},
  protected_branches: [],
  push_limits: { files: 50, lines: 2_000 },
};
// A damaged file falls back to asking: never silently more automatic than intended.
const FALLBACK: AgentPolicy = { ...DEFAULT, mine: false, others: false };

function migrate(v1: z.infer<typeof PolicyV1Schema>): AgentPolicy {
  const at = new Date().toISOString();
  return {
    ...structuredClone(DEFAULT),
    sessions: Object.fromEntries(
      Object.entries(v1.sessions).map(([id, s]) => [
        id,
        { others: s.auto, ...(s.since && { others_since: s.since }) },
      ]),
    ),
    approvals: Object.fromEntries(
      Object.entries(v1.allowed).map(([id, events]) => [
        id,
        Object.fromEntries(events.map((e) => [e, { at }])),
      ]),
    ),
  };
}

export function readPolicy(home: string): AgentPolicy {
  const file = join(home, FILE);
  if (!existsSync(file)) return structuredClone(DEFAULT);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(FALLBACK);
  }
  const parsed = PolicySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const v1 = PolicyV1Schema.safeParse(raw);
  return v1.success ? migrate(v1.data) : structuredClone(FALLBACK);
}

function writePolicy(home: string, policy: AgentPolicy): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(PolicySchema.parse(policy), null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(`${file}.tmp`, file);
}

export function isAuto(home: string, sessionId: string, mode: AutoMode): boolean {
  const policy = readPolicy(home);
  return policy.sessions[sessionId]?.[mode] ?? policy[mode];
}

export function setAuto(
  home: string,
  sessionId: string | undefined,
  mode: AutoMode,
  on: boolean,
): void {
  const policy = readPolicy(home);
  if (sessionId) {
    const current = { ...policy.sessions[sessionId] };
    current[mode] = on;
    if (on) current[`${mode}_since`] = new Date().toISOString();
    else delete current[`${mode}_since`];
    policy.sessions[sessionId] = current;
  } else {
    policy[mode] = on;
  }
  writePolicy(home, policy);
}

/** When this mode was switched on for this session, if it was switched on explicitly. */
export function autoSince(home: string, sessionId: string, mode: AutoMode): string | undefined {
  return readPolicy(home).sessions[sessionId]?.[`${mode}_since`];
}

export function sharesStatus(home: string, sessionId: string): boolean {
  return readPolicy(home).sessions[sessionId]?.share_status ?? true;
}

export function setShareStatus(home: string, sessionId: string, on: boolean): void {
  const policy = readPolicy(home);
  policy.sessions[sessionId] = { ...policy.sessions[sessionId], share_status: on };
  writePolicy(home, policy);
}

export function approvalOf(home: string, sessionId: string, eventId: string): Approval | undefined {
  return readPolicy(home).approvals[sessionId]?.[eventId];
}

function recordApproval(home: string, sessionId: string, eventId: string, approval: Approval) {
  const policy = readPolicy(home);
  const entries = Object.entries({ ...policy.approvals[sessionId], [eventId]: approval });
  // Keep the most recent ones; an old item that falls out simply waits for the owner again.
  entries.sort(([, a], [, b]) => a.at.localeCompare(b.at));
  policy.approvals[sessionId] = Object.fromEntries(entries.slice(-MAX_APPROVALS));
  writePolicy(home, policy);
}

/**
 * The owner lets their agent handle one item. With `text`, the agent reads the owner's edited
 * version instead of the original, and that version counts as written by the owner (ADR-0007).
 */
export function allowItem(home: string, sessionId: string, eventId: string, text?: string): void {
  recordApproval(home, sessionId, eventId, {
    at: new Date().toISOString(),
    ...(text?.trim() && { text: text.trim() }),
  });
}

export function declineItem(home: string, sessionId: string, eventId: string): void {
  recordApproval(home, sessionId, eventId, { at: new Date().toISOString(), declined: true });
}

/** Branches the agent may never push to, besides the remote's default branch. */
export function protectedBranches(home: string): string[] {
  return ['main', 'master', ...readPolicy(home).protected_branches];
}

export function pushLimits(home: string): AgentPolicy['push_limits'] {
  return readPolicy(home).push_limits;
}
