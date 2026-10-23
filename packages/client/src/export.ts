import {
  CHAIN_VERSION,
  chainGenesis,
  chainLinkHash,
  eventContentHash,
  ParticipantJoinedSchema,
  publicKeyFromRaw,
  type SequencedEvent,
  SequencedEventSchema,
  userIdFromPublicKey,
  verifyEventSignature,
  verifyProof,
} from '@pearcoderhq/protocol';
import { packagesOf, participantsOf, requestsOf } from './views.js';

export interface FindingView {
  id: string;
  author: string;
  agent: boolean;
  title: string;
  severity: string;
  body: string;
  location?: string;
  request?: string;
  resolution?: { by: string; resolution: string; note?: string };
  replies: { author: string; text: string; at: string }[];
}

export interface DecisionView {
  id: string;
  proposer: string;
  title: string;
  decision: string;
  rationale?: string;
  alternatives: string[];
  related: string[];
  votes: Record<string, { stance: string; note?: string }>;
  outcome?: { by: string; outcome: string; note?: string };
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

export function findingsOf(events: SequencedEvent[]): FindingView[] {
  const findings = new Map<string, FindingView>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'review.finding') {
      const loc = p.location as
        | { path?: string; start_line?: number; end_line?: number }
        | undefined;
      findings.set(e.id, {
        id: e.id,
        author: e.actor_user_id,
        agent: Boolean(e.actor_agent_id),
        title: String(p.title),
        severity: String(p.severity),
        body: String(p.body),
        ...(loc?.path && {
          location: `${loc.path}${loc.start_line ? `:${loc.start_line}${loc.end_line && loc.end_line !== loc.start_line ? `-${loc.end_line}` : ''}` : ''}`,
        }),
        ...(typeof p.request === 'string' && { request: p.request }),
        replies: [],
      });
    } else if (e.type === 'finding.resolved') {
      const f = findings.get(String(p.finding));
      if (f) {
        f.resolution = {
          by: e.actor_user_id,
          resolution: String(p.resolution),
          ...(typeof p.note === 'string' && { note: p.note }),
        };
      }
    } else if (e.type === 'message.created' && e.reply_to) {
      findings
        .get(e.reply_to)
        ?.replies.push({ author: e.actor_user_id, text: String(p.text), at: e.received_at });
    }
  }
  return [...findings.values()].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}

export function decisionsOf(events: SequencedEvent[]): DecisionView[] {
  const decisions = new Map<string, DecisionView>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'decision.proposed') {
      decisions.set(e.id, {
        id: e.id,
        proposer: e.actor_user_id,
        title: String(p.title),
        decision: String(p.decision),
        ...(typeof p.rationale === 'string' && { rationale: p.rationale }),
        alternatives: (p.alternatives as string[] | undefined) ?? [],
        related: (p.related as string[] | undefined) ?? [],
        votes: {},
      });
    } else if (e.type === 'decision.vote') {
      const d = decisions.get(String(p.decision));
      if (d)
        d.votes[e.actor_user_id] = {
          stance: String(p.stance),
          ...(typeof p.note === 'string' && { note: p.note }),
        };
    } else if (e.type === 'decision.resolved') {
      const d = decisions.get(String(p.decision));
      if (d) {
        d.outcome = {
          by: e.actor_user_id,
          outcome: String(p.outcome),
          ...(typeof p.note === 'string' && { note: p.note }),
        };
      }
    }
  }
  return [...decisions.values()];
}

const RESOLUTION_LABEL: Record<string, string> = {
  fixed: 'fixed',
  accepted_risk: 'accepted risk',
  wont_fix: "won't fix",
  invalid: 'not an issue',
};

/** One line of Markdown text: no headings, lists or HTML can be injected by participants. */
function inline(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
    .trim();
}

/** Multi-line participant text as a Markdown blockquote, so it cannot restructure the document. */
function quote(text: string): string {
  return text
    .replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * The session's outcome as one document: what was reviewed, what was found and how it was
 * resolved, what was decided, and what is still open. Ready to paste into a PR or an ADR.
 */
export function renderReviewMarkdown(
  events: SequencedEvent[],
  options: { sessionName: string; footer?: boolean },
): string {
  const names = new Map(participantsOf(events).map((p) => [p.user_id, p.display_name]));
  const name = (id: string) => inline(names.get(id) ?? id);
  const packages = packagesOf(events);
  const requests = requestsOf(events);
  const findings = findingsOf(events);
  const decisions = decisionsOf(events);
  const repoOf = new Map(
    events
      .filter((e) => e.type === 'context_package.published')
      .map((e) => [
        e.id,
        e.payload.repo as { name?: string; base?: string; head?: string } | undefined,
      ]),
  );
  const out: string[] = [`# Review: ${inline(options.sessionName)}`];
  const first = events[0]?.received_at.slice(0, 10);
  const last = events.at(-1)?.received_at.slice(0, 10);
  out.push(
    `${first === last ? first : `${first} – ${last}`} · ${participantsOf(events)
      .map((p) => `${inline(p.display_name)} (${p.role})`)
      .join(', ')}`,
  );

  if (packages.length) {
    out.push('## What was reviewed');
    for (const p of packages) {
      const repo = repoOf.get(p.id);
      const ref = repo?.head
        ? ` at \`${repo.head.slice(0, 12)}\`${repo.base ? ` (base \`${repo.base.slice(0, 12)}\`)` : ''}`
        : '';
      out.push(
        `- **${inline(p.title)}** (v${p.version}) by ${name(p.author)}${repo?.name ? ` in ${inline(repo.name)}` : ''}${ref}. Objective: ${inline(p.objective)}`,
      );
    }
  }

  if (requests.length) {
    out.push('## Requests');
    for (const r of requests) {
      const states = r.to.map((u) => `${name(u)}: ${r.resolutions[u] ?? 'open'}`).join(', ');
      out.push(`- ${inline(r.title)} (${r.kind}, from ${inline(r.from_name)}) · ${states}`);
    }
  }

  out.push(`## Findings (${findings.length})`);
  if (!findings.length) out.push('_No findings._');
  for (const f of findings) {
    const status = f.resolution
      ? `${RESOLUTION_LABEL[f.resolution.resolution] ?? f.resolution.resolution} (${name(f.resolution.by)})`
      : 'open';
    out.push(
      `### [${f.severity.toUpperCase()}] ${inline(f.title)}`,
      `${name(f.author)}${f.agent ? "'s agent" : ''}${f.location ? ` · \`${inline(f.location)}\`` : ''} · **${status}**`,
      quote(f.body),
    );
    if (f.resolution?.note) out.push(`Resolution note: ${inline(f.resolution.note)}`);
    for (const reply of f.replies) out.push(`- ${name(reply.author)}: ${inline(reply.text)}`);
  }

  if (decisions.length) {
    out.push('## Decisions');
    for (const d of decisions) {
      const outcome = d.outcome ? `${d.outcome.outcome} by ${name(d.outcome.by)}` : 'proposed';
      out.push(`### ${inline(d.title)} (${outcome})`, quote(d.decision));
      if (d.rationale) out.push(`**Rationale.** ${inline(d.rationale)}`);
      if (d.alternatives.length)
        out.push(`**Alternatives considered.** ${d.alternatives.map(inline).join('; ')}`);
      const votes = Object.entries(d.votes);
      if (votes.length)
        out.push(
          `**Stances.** ${votes.map(([u, v]) => `${name(u)}: ${v.stance}${v.note ? ` (${inline(v.note)})` : ''}`).join('; ')}`,
        );
      const related = d.related
        .map((id) => findings.find((f) => f.id === id))
        .filter((f) => f !== undefined)
        .map((f) => `[${f.severity.toUpperCase()}] ${inline(f.title)}`);
      if (related.length) out.push(`**Addresses.** ${related.join('; ')}`);
      if (d.outcome?.note) out.push(`**Outcome note.** ${inline(d.outcome.note)}`);
    }
  }

  const openFindings = findings.filter((f) => !f.resolution);
  const openDecisions = decisions.filter((d) => !d.outcome);
  const acted = decisions.filter((d) => d.outcome?.outcome === 'accepted');
  if (openFindings.length || openDecisions.length || acted.length) {
    out.push('## Action items');
    for (const f of openFindings)
      out.push(
        `- [ ] Resolve [${f.severity}] ${inline(f.title)}${f.location ? ` (\`${inline(f.location)}\`)` : ''}`,
      );
    for (const d of openDecisions) out.push(`- [ ] Decide: ${inline(d.title)}`);
    for (const d of acted) out.push(`- [ ] Implement: ${inline(d.title)}`);
  }

  if (options.footer !== false) {
    out.push(
      '---',
      "_Reviewed with [Pearcoder](https://github.com/pearcoderhq), where agents and humans have a tea party. Every entry is signed by its author and sealed into the host's hash chain; `pearcoder verify` checks a `--format jsonl` export of this session._",
    );
  }
  return `${out.join('\n\n')}\n`;
}

/** The signed log as JSON Lines: re-importable and verifiable by anyone. */
export function renderJsonl(events: SequencedEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
}

export interface VerifyReport {
  ok: boolean;
  events: number;
  /** True when every event carries a host seal, so removed, reordered or re-timed events show. */
  sealed: boolean;
  problems: string[];
}

/**
 * Checks an exported log: every event is well formed and signed by the key its author joined
 * with, and the host's hash chain links every event to the one before (threat model T09). A
 * sealed log detects removed, reordered, renumbered or re-timed events; a log cut short at the
 * end still verifies, as a prefix of the host's history.
 */
export function verifyExport(jsonl: string): VerifyReport {
  const problems: string[] = [];
  const keys = new Map<string, ReturnType<typeof publicKeyFromRaw>>();
  let hostKey: ReturnType<typeof publicKeyFromRaw> | undefined;
  let prev: string | undefined;
  let count = 0;
  let sealedCount = 0;
  let promisedSeal = false;
  let notEvents = 0;
  const lines = jsonl.split('\n').filter((line) => line.trim());
  if (lines.length === 0) problems.push('no events: the file is empty');
  lines.forEach((line, index) => {
    count += 1;
    const where = `line ${index + 1}`;
    let event: SequencedEvent;
    try {
      event = SequencedEventSchema.parse(JSON.parse(line));
    } catch {
      notEvents += 1;
      if (notEvents <= 3) problems.push(`${where}: not a Pearcoder event`);
      return;
    }
    if (event.sequence !== index + 1)
      problems.push(`${where}: expected sequence ${index + 1}, got ${event.sequence}`);
    if (event.type === 'participant.joined') {
      const joined = ParticipantJoinedSchema.safeParse(event.payload);
      if (
        joined.success &&
        userIdFromPublicKey(Buffer.from(joined.data.public_key, 'base64url')) ===
          event.actor_user_id
      ) {
        const key = publicKeyFromRaw(joined.data.public_key);
        keys.set(event.actor_user_id, key);
        if (joined.data.role === 'host' && index === 0) {
          hostKey = key;
          promisedSeal = joined.data.seals === CHAIN_VERSION;
        }
      } else {
        problems.push(`${where}: join does not match its key`);
      }
    }
    const key = keys.get(event.actor_user_id);
    if (!key) problems.push(`${where}: author never joined`);
    else if (!verifyEventSignature(event, key))
      problems.push(`${where}: signature does not verify`);

    if (event.chain) {
      sealedCount += 1;
      const expectedPrev = prev ?? chainGenesis(event.session_id);
      if (event.chain.prev !== expectedPrev)
        problems.push(`${where}: chain broken (an event before it was removed or reordered)`);
      const hash = chainLinkHash({
        prev: event.chain.prev,
        sequence: event.sequence,
        receivedAt: event.received_at,
        contentHash: eventContentHash(event),
      });
      if (hash !== event.chain.hash)
        problems.push(`${where}: chain hash mismatch (sequence or time was changed)`);
      else if (!hostKey || !verifyProof(Buffer.from(hash, 'utf8'), event.chain.sig, hostKey)) {
        problems.push(`${where}: host seal does not verify`);
      }
      prev = event.chain.hash;
    } else if (sealedCount > 0) {
      problems.push(`${where}: missing host seal in a sealed log`);
    }
  });
  if (notEvents === count && count > 0) {
    problems.splice(
      0,
      problems.length,
      'not a Pearcoder log: export one with `pearcoder export --format jsonl`',
    );
  } else if (notEvents > 3) {
    problems.push(`… ${notEvents - 3} more lines are not Pearcoder events`);
  }
  const sealed = count > 0 && sealedCount === count;
  if (promisedSeal && !sealed && sealedCount === 0) {
    problems.push('host seals were removed: the host signed that it seals every event');
  }
  return { ok: problems.length === 0, events: count, sealed, problems };
}
