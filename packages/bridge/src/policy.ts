import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * How the owner's agent may act in each session (ADR-0006). Kept on the owner's machine only.
 * `auto`: the agent picks up mentions and requests without asking, and the local node sends its
 * drafts after the secret scan. When off, each item waits for the owner's go-ahead, and each draft
 * waits for Send.
 */
const PolicySchema = z.object({
  v: z.literal(1),
  /** Default for sessions without their own setting. */
  auto: z.boolean(),
  /** `since`: when auto was last switched on; only drafts created after it are sent on their own. */
  sessions: z.record(
    z.string(),
    z.object({ auto: z.boolean(), since: z.iso.datetime().optional() }),
  ),
  /** Items the owner let their agent handle while auto was off, by session. */
  allowed: z.record(z.string(), z.array(z.string()).max(500)),
});
export type AgentPolicy = z.infer<typeof PolicySchema>;

const FILE = 'agent-policy.json';
const DEFAULT: AgentPolicy = { v: 1, auto: true, sessions: {}, allowed: {} };

export function readPolicy(home: string): AgentPolicy {
  const file = join(home, FILE);
  if (!existsSync(file)) return structuredClone(DEFAULT);
  const parsed = PolicySchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  // A damaged file falls back to asking: never silently more automatic than intended.
  return parsed.success ? parsed.data : { ...structuredClone(DEFAULT), auto: false };
}

function writePolicy(home: string, policy: AgentPolicy): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(PolicySchema.parse(policy), null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(`${file}.tmp`, file);
}

export function isAuto(home: string, sessionId: string): boolean {
  const policy = readPolicy(home);
  return policy.sessions[sessionId]?.auto ?? policy.auto;
}

export function setAuto(home: string, sessionId: string | undefined, auto: boolean): void {
  const policy = readPolicy(home);
  if (sessionId) {
    policy.sessions[sessionId] = { auto, ...(auto && { since: new Date().toISOString() }) };
  } else {
    policy.auto = auto;
  }
  writePolicy(home, policy);
}

/** When auto was switched on for this session, if it was switched on explicitly. */
export function autoSince(home: string, sessionId: string): string | undefined {
  return readPolicy(home).sessions[sessionId]?.since;
}

export function isAllowed(home: string, sessionId: string, eventId: string): boolean {
  return readPolicy(home).allowed[sessionId]?.includes(eventId) ?? false;
}

/** The owner lets their agent handle one request or mention while auto is off. */
export function allowItem(home: string, sessionId: string, eventId: string): void {
  const policy = readPolicy(home);
  const list = policy.allowed[sessionId] ?? [];
  if (!list.includes(eventId)) list.push(eventId);
  policy.allowed[sessionId] = list.slice(-500);
  writePolicy(home, policy);
}
