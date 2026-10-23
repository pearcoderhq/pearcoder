import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactValue, scanValue } from '@pearcoderhq/core';
import type { SequencedEvent } from '@pearcoderhq/protocol';
import { gh, sanitizeRemote } from './context-package.js';
import { ClientError } from './errors.js';
import { participantsOf } from './views.js';

export interface GithubReviewOptions {
  cwd: string;
  /** PR number (in the current repository) or URL. */
  pr: string;
  /** Also post findings that were already resolved in the session. */
  includeResolved?: boolean;
  /** For tests: the `gh` executable. */
  ghBin?: string;
}

export interface GithubReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: 'RIGHT';
  start_side?: 'RIGHT';
  body: string;
}

/** A GitHub pull request review built from a session's findings, ready to preview or post. */
export interface GithubReviewPlan {
  repo: string;
  number: number;
  url: string;
  commitId: string;
  body: string;
  comments: GithubReviewComment[];
  /** Finding ids included, inline or in the review body. */
  findings: string[];
  /**
   * Secrets found and redacted. A finding allowed into the session with --allow-secrets was
   * shared with its participants, not with everyone who can read the repository.
   */
  redacted: number;
}

interface PrTarget {
  host: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
}

async function prTarget(bin: string, cwd: string, pr: string): Promise<PrTarget> {
  const view = JSON.parse(await gh(bin, cwd, ['pr', 'view', pr, '--json', 'number,url'])) as {
    number: number;
    url: string;
  };
  const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(view.url);
  if (!match) throw new ClientError('GH_FAILED', `unexpected PR URL ${view.url}`);
  const [, host, owner, repo] = match as unknown as [string, string, string, string];
  return { host, owner, repo, number: view.number, url: sanitizeRemote(view.url) };
}

const hostArgs = (t: PrTarget) => (t.host === 'github.com' ? [] : ['--hostname', t.host]);

/** New-side line numbers GitHub accepts review comments on, per file, from a unified diff. */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  let line = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      current = undefined;
    } else if (text.startsWith('+++ ')) {
      const path = text.slice(4).replace(/^b\//, '');
      current = path === '/dev/null' ? undefined : new Set();
      if (current) files.set(path, current);
    } else if (text.startsWith('@@')) {
      line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0);
    } else if (current && line > 0) {
      if (text.startsWith('+') || text.startsWith(' ')) {
        current.add(line);
        line += 1;
      } else if (text.startsWith('\\')) {
        // "\ No newline at end of file"
      } else if (!text.startsWith('-')) {
        line = 0;
      }
    }
  }
  return files;
}

interface FindingInfo {
  id: string;
  author: string;
  agent: boolean;
  title: string;
  severity: string;
  body: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  packageId?: string;
  resolved?: string;
}

function findingsWithPackages(events: SequencedEvent[]): FindingInfo[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const list = new Map<string, FindingInfo>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'review.finding') {
      const loc = p.location as
        | { path?: string; start_line?: number; end_line?: number }
        | undefined;
      const request = p.request ? byId.get(String(p.request)) : undefined;
      const packageId = p.context_package ?? request?.payload.context_package;
      list.set(e.id, {
        id: e.id,
        author: e.actor_user_id,
        agent: Boolean(e.actor_agent_id),
        title: String(p.title),
        severity: String(p.severity),
        body: String(p.body),
        ...(loc?.path && { path: loc.path }),
        ...(loc?.start_line && { startLine: loc.start_line }),
        ...(loc?.end_line && { endLine: loc.end_line }),
        ...(packageId !== undefined && { packageId: String(packageId) }),
      });
    } else if (e.type === 'finding.resolved') {
      const finding = list.get(String(p.finding));
      if (finding) finding.resolved = String(p.resolution);
    }
  }
  return [...list.values()];
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * Plans a GitHub review for a pull request from the session's findings about it: the findings
 * linked (directly or through their request) to a context package shared from that PR. Findings on
 * lines in the current diff become inline comments; the rest go in the review body. Nothing is
 * posted; see `postGithubReview`.
 */
export async function planGithubReview(
  events: SequencedEvent[],
  options: GithubReviewOptions,
): Promise<GithubReviewPlan> {
  const bin = options.ghBin ?? 'gh';
  const target = await prTarget(bin, options.cwd, options.pr);
  const packages = events.filter((e) => {
    const repo = e.payload.repo as { url?: string } | undefined;
    return e.type === 'context_package.published' && repo?.url === target.url;
  });
  if (packages.length === 0) {
    throw new ClientError(
      'NO_PR_PACKAGE',
      `no context package for ${target.url} in this session; share it first with: pearcoder share --pr ${target.number}`,
    );
  }
  const packageIds = new Set(packages.map((e) => e.id));
  const findings = findingsWithPackages(events)
    .filter((f) => f.packageId && packageIds.has(f.packageId))
    .filter((f) => options.includeResolved || !f.resolved)
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  const pull = JSON.parse(
    await gh(bin, options.cwd, [
      'api',
      ...hostArgs(target),
      `repos/${target.owner}/${target.repo}/pulls/${target.number}`,
    ]),
  ) as { head: { sha: string } };
  const lines = commentableLines(await gh(bin, options.cwd, ['pr', 'diff', options.pr]));

  const names = new Map(participantsOf(events).map((p) => [p.user_id, p.display_name]));
  const byline = (f: FindingInfo) =>
    `${names.get(f.author) ?? 'Someone'}${f.agent ? "'s agent" : ''}`;
  const render = (f: FindingInfo) =>
    `**[${f.severity.toUpperCase()}] ${f.title}**${f.resolved ? ` _(${f.resolved.replace('_', ' ')} in the session)_` : ''}\n\n${f.body}\n\n<sub>${byline(f)}, via Pearcoder</sub>`;

  const comments: GithubReviewComment[] = [];
  const general: FindingInfo[] = [];
  for (const f of findings) {
    const end = f.endLine ?? f.startLine;
    const onDiff = f.path && end && lines.get(f.path);
    if (onDiff && end && onDiff.has(end)) {
      const start =
        f.startLine && f.startLine < end && onDiff.has(f.startLine) ? f.startLine : undefined;
      comments.push({
        path: f.path as string,
        line: end,
        side: 'RIGHT',
        ...(start && { start_line: start, start_side: 'RIGHT' as const }),
        body: render(f),
      });
    } else {
      general.push(f);
    }
  }

  const reviewedHeads = new Set(
    packages.map((e) => (e.payload.repo as { head?: string } | undefined)?.head).filter(Boolean),
  );
  const moved = !reviewedHeads.has(pull.head.sha)
    ? `\n\n_Reviewed at ${[...reviewedHeads].map((h) => `\`${String(h).slice(0, 12)}\``).join(', ')}; the PR has moved since._`
    : '';
  const body = [
    `### Pearcoder review: ${findings.length} finding${findings.length === 1 ? '' : 's'}${comments.length ? ` (${comments.length} inline)` : ''}${moved}`,
    ...general.map(
      (f) =>
        `${f.path ? `\`${f.path}${f.startLine ? `:${f.startLine}` : ''}\`\n\n` : ''}${render(f)}`,
    ),
  ].join('\n\n---\n\n');

  const redacted = scanValue({ body, comments }).length;
  return {
    repo: `${target.owner}/${target.repo}`,
    number: target.number,
    url: target.url,
    commitId: pull.head.sha,
    body: redacted ? redactValue(body) : body,
    comments: redacted ? redactValue(comments) : comments,
    findings: findings.map((f) => f.id),
    redacted,
  };
}

/** Posts a planned review as one GitHub "comment" review (it never approves or requests changes). */
export async function postGithubReview(
  plan: GithubReviewPlan,
  options: { cwd: string; ghBin?: string },
): Promise<{ url: string }> {
  const bin = options.ghBin ?? 'gh';
  const match = /^https:\/\/([^/]+)\//.exec(plan.url);
  const host = match?.[1] ?? 'github.com';
  const dir = mkdtempSync(join(tmpdir(), 'pearcoder-review-'));
  try {
    const input = join(dir, 'review.json');
    writeFileSync(
      input,
      JSON.stringify({
        commit_id: plan.commitId,
        event: 'COMMENT',
        body: plan.body,
        comments: plan.comments,
      }),
      { mode: 0o600 },
    );
    const posted = JSON.parse(
      await gh(bin, options.cwd, [
        'api',
        ...(host === 'github.com' ? [] : ['--hostname', host]),
        '--method',
        'POST',
        `repos/${plan.repo}/pulls/${plan.number}/reviews`,
        '--input',
        input,
      ]),
    ) as { html_url?: string };
    return { url: posted.html_url ?? plan.url };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
