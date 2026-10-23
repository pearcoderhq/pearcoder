import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * What the owner's agent runs are doing, shared between the MCP server (which the runs call) and
 * the local node (which shows it and publishes `activity.changed`). Local only, like drafts.
 * - `listen`: `/pearcoder:listen`, drafts findings and replies (ADR-0005).
 * - `dev`: `/pearcoder:dev`, changes code for the owner's own items (ADR-0007).
 */
export type RunFlow = 'listen' | 'dev';

const ClaimSchema = z.object({
  session: z.string(),
  item: z.string(),
  flow: z.enum(['listen', 'dev']),
  harness: z.string().max(100),
  at: z.iso.datetime(),
  released_at: z.iso.datetime().optional(),
  /** The owner pressed Stop: the run must not push for this item any more. */
  stopped_at: z.iso.datetime().optional(),
  pushes: z.number().int().min(0).default(0),
  /** `dev` runs: the repository's git config when the item was claimed (see git_commit_push). */
  git_config: z.string().max(128).optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

const RunsSchema = z.object({
  v: z.literal(1),
  /** Last call to a wait tool, by flow: a run counts as active for a while after it. */
  heartbeats: z.record(z.string(), z.object({ at: z.iso.datetime(), harness: z.string() })),
  claims: z.array(ClaimSchema).max(2_000),
});
type Runs = z.infer<typeof RunsSchema>;

const FILE = 'agent-runs.json';
/** A run that has not waited for this long is treated as gone. */
export const RUN_ACTIVE_MS = 2 * 60_000;
/** A claim older than this no longer counts as work in progress. */
export const CLAIM_ACTIVE_MS = 30 * 60_000;
const KEEP_MS = 24 * 3_600_000;

function read(home: string): Runs {
  const file = join(home, FILE);
  if (!existsSync(file)) return { v: 1, heartbeats: {}, claims: [] };
  try {
    return RunsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { v: 1, heartbeats: {}, claims: [] };
  }
}

function write(home: string, runs: Runs, now: number): void {
  runs.claims = runs.claims.filter((c) => now - Date.parse(c.at) < KEEP_MS).slice(-2_000);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(runs, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** A wait call: the run is alive, and it is done with whatever it claimed before. */
export function heartbeat(home: string, flow: RunFlow, harness: string, now = Date.now()): void {
  const runs = read(home);
  runs.heartbeats[flow] = { at: new Date(now).toISOString(), harness };
  for (const claim of runs.claims) {
    if (claim.flow === flow && !claim.released_at) claim.released_at = new Date(now).toISOString();
  }
  write(home, runs, now);
}

export function isRunActive(home: string, flow: RunFlow, now = Date.now()): boolean {
  const beat = read(home).heartbeats[flow];
  return Boolean(beat && now - Date.parse(beat.at) < RUN_ACTIVE_MS);
}

export function activeRuns(home: string, now = Date.now()): { flow: RunFlow; harness: string }[] {
  return Object.entries(read(home).heartbeats)
    .filter(([, b]) => now - Date.parse(b.at) < RUN_ACTIVE_MS)
    .map(([flow, b]) => ({ flow: flow as RunFlow, harness: b.harness }));
}

export function claim(
  home: string,
  input: { session: string; item: string; flow: RunFlow; harness: string; git_config?: string },
  now = Date.now(),
): void {
  const runs = read(home);
  if (
    runs.claims.some((c) => c.session === input.session && c.item === input.item && !c.released_at)
  )
    return;
  runs.claims.push({ ...input, at: new Date(now).toISOString(), pushes: 0 });
  write(home, runs, now);
}

/** The open claim on this item, if a run is working on it. */
export function claimOf(
  home: string,
  session: string,
  item: string,
  now = Date.now(),
): Claim | undefined {
  return read(home).claims.find(
    (c) =>
      c.session === session &&
      c.item === item &&
      !c.released_at &&
      now - Date.parse(c.at) < CLAIM_ACTIVE_MS,
  );
}

/** Items any run claimed, open or released, so a second run does not pick them up again. */
export function claimedItems(home: string): Set<string> {
  return new Set(read(home).claims.map((c) => `${c.session}:${c.item}`));
}

export function openClaims(home: string, now = Date.now()): Claim[] {
  return read(home).claims.filter(
    (c) => !c.released_at && now - Date.parse(c.at) < CLAIM_ACTIVE_MS,
  );
}

/** The owner's Stop: ends the claim, and the run's next wait tells it to stop. */
export function stopItem(home: string, session: string, item: string, now = Date.now()): boolean {
  const runs = read(home);
  const open = runs.claims.find((c) => c.session === session && c.item === item && !c.released_at);
  if (!open) return false;
  open.stopped_at = new Date(now).toISOString();
  open.released_at = open.stopped_at;
  write(home, runs, now);
  return true;
}

/** Stops recorded since the run's last wait, which it must report and obey. */
export function wasStopped(home: string, session: string, item: string): boolean {
  return read(home).claims.some(
    (c) => c.session === session && c.item === item && c.stopped_at !== undefined,
  );
}

export function countPush(home: string, session: string, item: string, now = Date.now()): void {
  const runs = read(home);
  const open = runs.claims.find((c) => c.session === session && c.item === item && !c.released_at);
  if (open) open.pushes += 1;
  write(home, runs, now);
}
