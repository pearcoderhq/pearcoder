import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { scanValue } from '@pearcoderhq/core';
import { BranchNameSchema } from '@pearcoderhq/protocol';

const run = promisify(execFile);

export class PushRefusedError extends Error {}

export interface GitContext {
  cwd: string;
  home: string;
  gitBin?: string;
}

/**
 * Settings on every git call made for the agent. Hooks run code, and a repository can version
 * them (husky and similar), so they are off; fsmonitor too. Config the agent might have planted
 * in `.git/config` is caught by `gitConfigFingerprint`.
 */
function safety(ctx: GitContext): string[] {
  const hooks = join(ctx.home, 'empty-hooks');
  mkdirSync(hooks, { recursive: true, mode: 0o700 });
  return ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false'];
}

async function git(ctx: GitContext, args: string[], timeout = 30_000): Promise<string> {
  try {
    const { stdout } = await run(ctx.gitBin ?? 'git', [...safety(ctx), ...args], {
      cwd: ctx.cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout,
      // Never wait for a password prompt nobody will see.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    return stdout.trim();
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new PushRefusedError(
      `git ${args[0]} failed: ${(e.stderr || e.message).trim().split('\n').slice(0, 3).join(' ')}`,
    );
  }
}

const gitOrEmpty = (ctx: GitContext, args: string[]) => git(ctx, args).catch(() => '');

/**
 * A hash of the repository's git config. Taken when a run claims an item and checked before
 * pushing: if the agent changed it in between (an alias, a filter, sshCommand…), nothing runs.
 */
export async function gitConfigFingerprint(ctx: GitContext): Promise<string> {
  const absolute = (p: string) => (isAbsolute(p) ? p : resolve(ctx.cwd, p));
  const common = absolute(await git(ctx, ['rev-parse', '--git-common-dir']));
  const own = absolute(await git(ctx, ['rev-parse', '--git-dir']));
  const hash = createHash('sha256');
  for (const file of [join(common, 'config'), join(own, 'config.worktree')]) {
    try {
      hash.update(readFileSync(file));
    } catch {
      hash.update('-');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** The remote URL without credentials, or nothing for a local path (which would leak a path). */
export function publicRemoteUrl(url: string): string | undefined {
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      parsed.username = '';
      parsed.password = '';
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return undefined;
    }
  }
  if (/^ssh:\/\/[^/]+\//i.test(url) || /^[\w.-]+@[\w.-]+:[^/]/.test(url)) return url;
  return undefined;
}

export interface PushResult {
  branch: string;
  commit: string;
  base?: string;
  remote: string;
  repo: { name: string; url?: string };
  files: number;
  lines: number;
}

/**
 * Commits everything changed in the worktree and pushes the current branch (ADR-0007). Refuses
 * the default branch and protected branches, never forces, never touches config or remotes.
 */
export async function commitAndPush(
  ctx: GitContext,
  input: {
    message: string;
    newBranch?: string;
    protectedBranches: string[];
    limits: { files: number; lines: number };
    expectedConfig?: string;
  },
): Promise<PushResult> {
  const root = await git(ctx, ['rev-parse', '--show-toplevel']);
  const inRoot: GitContext = { ...ctx, cwd: root };
  if (input.expectedConfig && (await gitConfigFingerprint(inRoot)) !== input.expectedConfig) {
    throw new PushRefusedError(
      'the git config changed while you worked on this item; nothing was committed. Your owner should check .git/config.',
    );
  }
  if (input.newBranch) {
    if (!BranchNameSchema.safeParse(input.newBranch).success) {
      throw new PushRefusedError(`${input.newBranch} is not a usable branch name`);
    }
    await git(inRoot, ['switch', '--quiet', '-c', input.newBranch]);
  }
  const branch = await git(inRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => {
    throw new PushRefusedError('HEAD is detached: pass new_branch to work on a branch');
  });
  if (!BranchNameSchema.safeParse(branch).success) {
    throw new PushRefusedError(`the current branch ${branch} can't be pushed by the agent`);
  }
  const remotes = (await git(inRoot, ['remote'])).split('\n').filter(Boolean);
  const remote =
    (await gitOrEmpty(inRoot, ['config', '--get', `branch.${branch}.remote`])) || 'origin';
  if (!remotes.includes(remote)) {
    throw new PushRefusedError(
      `no remote named ${remote} is configured; your owner adds remotes, the agent never does`,
    );
  }
  const head = await gitOrEmpty(inRoot, [
    'symbolic-ref',
    '--quiet',
    '--short',
    `refs/remotes/${remote}/HEAD`,
  ]);
  const defaultBranch = head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : undefined;
  const blocked = new Set([...input.protectedBranches, ...(defaultBranch ? [defaultBranch] : [])]);
  if (blocked.has(branch)) {
    throw new PushRefusedError(
      `${branch} is protected: the agent never pushes to it. Pass new_branch to put the work on a new branch.`,
    );
  }

  await git(inRoot, ['add', '--all']);
  const numstat = await git(inRoot, ['diff', '--cached', '--numstat', '--no-ext-diff']);
  const rows = numstat.split('\n').filter(Boolean);
  if (rows.length === 0) throw new PushRefusedError('there are no changes to commit');
  const lines = rows.reduce((sum, row) => {
    const [added, removed] = row.split('\t');
    return sum + (Number(added) || 0) + (Number(removed) || 0);
  }, 0);
  const unstage = () => gitOrEmpty(inRoot, ['reset', '--quiet']);
  if (rows.length > input.limits.files || lines > input.limits.lines) {
    await unstage();
    throw new PushRefusedError(
      `${rows.length} files and ${lines} changed lines are over the limit of ${input.limits.files} files and ${input.limits.lines} lines per push; your owner can raise it, or split the work`,
    );
  }
  // Pushed code is shared code: the same secret scan as any draft, on the lines being added.
  const added = (await git(inRoot, ['diff', '--cached', '--no-color', '--no-ext-diff', '-U0']))
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');
  const secrets = scanValue({ diff: added });
  if (secrets.length) {
    await unstage();
    throw new PushRefusedError(
      `the changes look like they contain secrets or private details (${[...new Set(secrets.map((s) => s.kind))].join(', ')}); nothing was committed`,
    );
  }

  await git(inRoot, ['commit', '--quiet', '--no-verify', '-m', input.message]);
  const commit = await git(inRoot, ['rev-parse', 'HEAD']);
  await git(
    inRoot,
    ['push', '--quiet', '--no-verify', remote, `HEAD:refs/heads/${branch}`],
    120_000,
  );
  const base = defaultBranch
    ? await gitOrEmpty(inRoot, ['merge-base', 'HEAD', `${remote}/${defaultBranch}`])
    : '';
  const url = publicRemoteUrl(await gitOrEmpty(inRoot, ['remote', 'get-url', remote]));
  const name =
    (url ?? root)
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .filter(Boolean)
      .pop() ?? basename(root);
  return {
    branch,
    commit,
    ...(/^[0-9a-f]{40,64}$/.test(base) && { base }),
    remote,
    repo: { name, ...(url && { url }) },
    files: rows.length,
    lines,
  };
}
