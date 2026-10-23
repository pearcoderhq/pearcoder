import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { type SecretFinding, scanValue } from '@pearcoderhq/core';
import { canonicalJson, maxEventBytes, withContextPackageHash } from '@pearcoderhq/protocol';
import { ClientError } from './errors.js';

const run = promisify(execFile);

export interface ExcerptSpec {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface BuildPackageOptions {
  /** Where the user ran the command; the repository is found from here. */
  cwd: string;
  /** Markdown file used as the package body (the spec). */
  specFile?: string;
  title?: string;
  objective: string;
  constraints?: string[];
  /** Files the reviewers should look at (listed, not copied). */
  paths?: string[];
  excerpts?: ExcerptSpec[];
  /** Branch or commit to diff against, e.g. `main`; recorded as the merge base. */
  base?: string;
  previous?: string;
  version?: number;
}

export interface BuiltPackage {
  payload: Record<string, unknown> & { hash: string };
  findings: SecretFinding[];
  bytes: number;
}

// Files that are never put into a package, even when named explicitly (threat model T18).
const NEVER_SHARE = [
  /(^|\/)\.env(\..*)?$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/,
  /(^|\/)\.pearcoder\//,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
];

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 10_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Drops credentials from remote URLs such as https://user:token@host/repo. */
export function sanitizeRemote(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    // scp-style `git@host:org/repo.git` has no password to strip.
    return url.replace(/^[^@/]+:[^@/]+@/, '');
  }
}

/**
 * Resolves a user-given path inside the repository root, following symlinks, and refuses
 * anything outside it or matching NEVER_SHARE.
 */
function confine(root: string, cwd: string, path: string): { absolute: string; relative: string } {
  const absolute = resolve(cwd, path);
  let real: string;
  try {
    real = realpathSync.native(absolute);
  } catch {
    throw new ClientError('PATH_NOT_FOUND', `${path} does not exist`);
  }
  const rel = relative(root, real);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new ClientError('PATH_OUTSIDE_REPO', `${path} is outside the repository`);
  }
  const posix = rel.split(sep).join('/');
  if (NEVER_SHARE.some((pattern) => pattern.test(posix))) {
    throw new ClientError(
      'PATH_NOT_SHAREABLE',
      `${path} looks like a secret file and is never shared`,
    );
  }
  return { absolute: real, relative: posix };
}

function readText(file: string): string {
  if (statSync(file).size > 1024 * 1024) {
    throw new ClientError('FILE_TOO_LARGE', `${file} is larger than 1 MiB`);
  }
  const text = readFileSync(file, 'utf8');
  if (text.includes('\u0000')) throw new ClientError('BINARY_FILE', `${file} is not a text file`);
  return text;
}

/** Builds a hashed `context_package.published` payload and scans it for secrets. */
export async function buildContextPackage(options: BuildPackageOptions): Promise<BuiltPackage> {
  const top = await git(options.cwd, ['rev-parse', '--show-toplevel']);
  // `.native` expands Windows 8.3 short names (RUNNER~1), so root and file paths compare equal.
  const root = realpathSync.native(top ?? options.cwd);
  const head = top ? await git(root, ['rev-parse', 'HEAD']) : undefined;
  const base =
    top && options.base ? await git(root, ['merge-base', options.base, 'HEAD']) : undefined;
  if (options.base && !base) {
    throw new ClientError('BASE_NOT_FOUND', `cannot find a merge base with ${options.base}`);
  }
  const remote = top ? await git(root, ['remote', 'get-url', 'origin']) : undefined;

  const spec = options.specFile ? confine(root, options.cwd, options.specFile) : undefined;
  const body = spec ? readText(spec.absolute) : '';
  const title =
    options.title ??
    /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ??
    (spec ? basename(spec.relative) : 'Context');

  const paths = (options.paths ?? []).map((p) => confine(root, options.cwd, p).relative);
  const excerpts = (options.excerpts ?? []).map((excerpt) => {
    const file = confine(root, options.cwd, excerpt.path);
    const lines = readText(file.absolute).split('\n');
    const start = excerpt.startLine ?? 1;
    const end = Math.min(excerpt.endLine ?? lines.length, lines.length);
    if (start < 1 || start > end) {
      throw new ClientError('INVALID_EXCERPT', `invalid line range for ${excerpt.path}`);
    }
    return {
      path: file.relative,
      start_line: start,
      end_line: end,
      text: lines.slice(start - 1, end).join('\n'),
    };
  });

  const payload = withContextPackageHash({
    title: title.slice(0, 200),
    objective: options.objective,
    constraints: options.constraints ?? [],
    ...(top && {
      repo: {
        name: basename(root),
        ...(remote && { url: sanitizeRemote(remote) }),
        ...(base && { base }),
        ...(head && { head }),
      },
    }),
    paths,
    excerpts,
    body,
    version: options.version ?? 1,
    ...(options.previous && { previous: options.previous }),
  });

  // Room for the envelope (ids, signature) around the payload.
  const bytes = Buffer.byteLength(canonicalJson(payload), 'utf8');
  if (bytes > maxEventBytes('context_package.published') - 4096) {
    throw new ClientError(
      'PACKAGE_TOO_LARGE',
      `package is ${bytes} bytes; the limit is about 250 KiB`,
    );
  }
  return { payload, findings: scanValue(payload), bytes };
}

export interface PullRequestPackageOptions {
  cwd: string;
  /** PR number (in the current repository) or URL. */
  pr: string;
  objective?: string;
  constraints?: string[];
  /** For tests: the `gh` executable. */
  ghBin?: string;
}

interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

const DIFF_BUDGET_BYTES = 180 * 1024;

export async function gh(bin: string, cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(bin, args, { cwd, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; code?: string; message: string };
    if (e.code === 'ENOENT') {
      throw new ClientError(
        'GH_NOT_FOUND',
        'GitHub CLI (gh) is not installed: https://cli.github.com',
      );
    }
    throw new ClientError(
      'GH_FAILED',
      (e.stderr || e.message).trim().split('\n')[0] ?? 'gh failed',
    );
  }
}

/** Splits a unified diff into per-file chunks (`diff --git` headers). */
function splitDiff(diff: string): string[] {
  return diff.split(/(?=^diff --git )/m).filter((chunk) => chunk.trim());
}

/**
 * Builds a context package from a GitHub pull request using the GitHub CLI: description, changed
 * files, exact base and head commits, and as much of the diff as fits (whole files, in order).
 */
export async function buildPullRequestPackage(
  options: PullRequestPackageOptions,
): Promise<BuiltPackage> {
  const bin = options.ghBin ?? 'gh';
  const view = JSON.parse(
    await gh(bin, options.cwd, [
      'pr',
      'view',
      options.pr,
      '--json',
      'number,title,body,url,headRefName,baseRefName',
    ]),
  ) as {
    number: number;
    title: string;
    body: string;
    url: string;
    headRefName: string;
    baseRefName: string;
  };
  const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(view.url);
  if (!match) throw new ClientError('GH_FAILED', `unexpected PR URL ${view.url}`);
  const [, host, owner, repo] = match;
  const apiBase = `repos/${owner}/${repo}/pulls/${view.number}`;
  const hostArgs = host === 'github.com' ? [] : ['--hostname', host as string];
  const pull = JSON.parse(await gh(bin, options.cwd, ['api', ...hostArgs, apiBase])) as {
    base: { sha: string };
    head: { sha: string };
  };
  const files = JSON.parse(
    await gh(bin, options.cwd, ['api', ...hostArgs, '--paginate', `${apiBase}/files?per_page=100`]),
  ) as PrFile[];
  const diff = await gh(bin, options.cwd, ['pr', 'diff', options.pr]);

  let used = 0;
  const included: string[] = [];
  const omitted: string[] = [];
  for (const chunk of splitDiff(diff)) {
    const name = /^diff --git a\/(\S+)/.exec(chunk)?.[1] ?? '?';
    const size = Buffer.byteLength(chunk, 'utf8');
    if (used + size <= DIFF_BUDGET_BYTES) {
      included.push(chunk);
      used += size;
    } else {
      omitted.push(name);
    }
  }
  const summary = files
    .map((f) => `- ${f.status} \`${f.filename}\` (+${f.additions} −${f.deletions})`)
    .join('\n');
  const body = [
    view.body?.trim() || '_No description._',
    `## Changes (${files.length} files)\n${summary}`,
    `## Diff\n\`\`\`diff\n${included.join('').trimEnd()}\n\`\`\``,
    omitted.length
      ? `_Diff omitted to fit the package size limit for: ${omitted.map((f) => `\`${f}\``).join(', ')}. Reviewers should read those files at the head commit._`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const payload = withContextPackageHash({
    title: `PR #${view.number}: ${view.title}`.slice(0, 200),
    objective:
      options.objective ?? `Review PR #${view.number} (${view.headRefName} → ${view.baseRefName})`,
    constraints: options.constraints ?? [],
    repo: {
      name: `${owner}/${repo}`,
      url: sanitizeRemote(view.url),
      base: pull.base.sha,
      head: pull.head.sha,
    },
    paths: files.slice(0, 200).map((f) => f.filename),
    excerpts: [],
    body,
    version: 1,
  });
  const bytes = Buffer.byteLength(canonicalJson(payload), 'utf8');
  if (bytes > maxEventBytes('context_package.published') - 4096) {
    throw new ClientError(
      'PACKAGE_TOO_LARGE',
      `package is ${bytes} bytes; the limit is about 250 KiB`,
    );
  }
  return { payload, findings: scanValue(payload), bytes };
}
