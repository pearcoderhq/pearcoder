// Covers: T12, T18
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextPackageHash } from '@pearcoderhq/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { buildContextPackage, sanitizeRemote } from '../src/context-package.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pearcoder-pkg-'));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(
    join(dir, 'docs', 'auth-spec.md'),
    '# Token rotation\n\nRefresh tokens rotate on every use.\n',
  );
  writeFileSync(join(dir, 'src', 'token.ts'), 'line1\nline2\nline3\nline4\n');
  writeFileSync(join(dir, '.env'), 'SECRET=abc\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', 'https://bob:supersecret@github.com/acme/auth.git');
  return dir;
}

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  );

describe('context package builder', () => {
  it('builds a hashed package with spec, paths, excerpts and git refs', async () => {
    const dir = repo();
    const built = await buildContextPackage({
      cwd: dir,
      specFile: 'docs/auth-spec.md',
      objective: 'Find races in rotation',
      constraints: ['No schema changes'],
      paths: ['src/token.ts'],
      excerpts: [{ path: 'src/token.ts', startLine: 2, endLine: 3 }],
    });
    const p = built.payload;
    expect(p.title).toBe('Token rotation');
    expect(p.body).toContain('rotate on every use');
    expect(p.paths).toEqual(['src/token.ts']);
    expect(p.excerpts).toEqual([
      { path: 'src/token.ts', start_line: 2, end_line: 3, text: 'line2\nline3' },
    ]);
    expect(p.repo).toMatchObject({
      url: 'https://github.com/acme/auth.git',
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(p.hash).toBe(contextPackageHash(p));
  });

  it('strips credentials from remote URLs', () => {
    expect(sanitizeRemote('https://user:token@github.com/a/b.git')).toBe(
      'https://github.com/a/b.git',
    );
    expect(sanitizeRemote('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
  });

  it('refuses paths outside the repo, via .. or symlinks (T18)', async () => {
    const dir = repo();
    const outside = mkdtempSync(join(tmpdir(), 'pearcoder-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    expect(
      await code(buildContextPackage({ cwd: dir, objective: 'o', paths: ['../../etc/hosts'] })),
    ).toMatch(/PATH_OUTSIDE_REPO|PATH_NOT_FOUND/);
    // Creating symlinks on Windows needs extra privileges; the escape check is the same code path.
    if (process.platform === 'win32') return;
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'src', 'link.txt'));
    expect(
      await code(
        buildContextPackage({ cwd: dir, objective: 'o', excerpts: [{ path: 'src/link.txt' }] }),
      ),
    ).toBe('PATH_OUTSIDE_REPO');
  });

  it('never shares secret-looking files, even when named', async () => {
    const dir = repo();
    expect(
      await code(buildContextPackage({ cwd: dir, objective: 'o', excerpts: [{ path: '.env' }] })),
    ).toBe('PATH_NOT_SHAREABLE');
  });

  it('reports secrets found in the content', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'docs', 'leaky.md'), `# Notes\nuse ghp_${'x'.repeat(36)} for CI\n`);
    const built = await buildContextPackage({
      cwd: dir,
      specFile: 'docs/leaky.md',
      objective: 'o',
    });
    expect(built.findings).toEqual([
      expect.objectContaining({ kind: 'github_token', field: 'body' }),
    ]);
  });

  it('rejects packages over the size limit and invalid excerpt ranges', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'docs', 'huge.md'), `# Huge\n${'x'.repeat(300_000)}`);
    expect(
      await code(buildContextPackage({ cwd: dir, specFile: 'docs/huge.md', objective: 'o' })),
    ).toBe('PACKAGE_TOO_LARGE');
    expect(
      await code(
        buildContextPackage({
          cwd: dir,
          objective: 'o',
          excerpts: [{ path: 'src/token.ts', startLine: 9 }],
        }),
      ),
    ).toBe('INVALID_EXCERPT');
  });
});

describe.runIf(process.platform !== 'win32')('pull request packages', () => {
  async function fakeGh(diff: string) {
    const { chmodSync, writeFileSync: write } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'pearcoder-gh-'));
    dirs.push(dir);
    write(join(dir, 'diff.txt'), diff);
    write(
      join(dir, 'view.json'),
      JSON.stringify({
        number: 7,
        title: 'Rotate refresh tokens atomically',
        body: `Fixes the race. Token for CI: ghp_${'p'.repeat(36)}`,
        url: 'https://github.com/acme/auth/pull/7',
        headRefName: 'fix/rotation',
        baseRefName: 'main',
      }),
    );
    write(
      join(dir, 'pull.json'),
      JSON.stringify({ base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } }),
    );
    write(
      join(dir, 'files.json'),
      JSON.stringify([
        { filename: 'src/token.ts', status: 'modified', additions: 5, deletions: 2 },
        { filename: 'src/huge.ts', status: 'added', additions: 9000, deletions: 0 },
      ]),
    );
    const bin = join(dir, 'gh');
    write(
      bin,
      `#!/bin/sh
case "$1 $2" in
  "pr view") cat "${dir}/view.json";;
  "pr diff") cat "${dir}/diff.txt";;
  "api repos/acme/auth/pulls/7") cat "${dir}/pull.json";;
  "api --paginate") cat "${dir}/files.json";;
  *) echo "unexpected: $@" >&2; exit 1;;
esac
`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  it('imports description, files, exact commits and the diff, trimming oversized files', async () => {
    const small =
      'diff --git a/src/token.ts b/src/token.ts\n--- a/src/token.ts\n+++ b/src/token.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const huge = `diff --git a/src/huge.ts b/src/huge.ts\n+++ b/src/huge.ts\n${'+x\n'.repeat(100_000)}`;
    const ghBin = await fakeGh(small + huge);
    const { buildPullRequestPackage } = await import('../src/context-package.js');
    const built = await buildPullRequestPackage({ cwd: tmpdir(), pr: '7', ghBin });
    const p = built.payload as unknown as Record<string, unknown> & {
      body: string;
      repo: Record<string, string>;
    };
    expect(p.title).toBe('PR #7: Rotate refresh tokens atomically');
    expect(p.objective).toBe('Review PR #7 (fix/rotation → main)');
    expect(p.repo).toEqual({
      name: 'acme/auth',
      url: 'https://github.com/acme/auth/pull/7',
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
    });
    expect(p.paths).toEqual(['src/token.ts', 'src/huge.ts']);
    expect(p.body).toContain('+new');
    expect(p.body).toContain('Diff omitted to fit the package size limit for: `src/huge.ts`');
    expect(p.hash).toBe(contextPackageHash(p));
    // The PR description's token is caught before anything is shared.
    expect(built.findings.map((f) => f.kind)).toContain('github_token');
  });

  it('explains when gh is missing', async () => {
    const { buildPullRequestPackage } = await import('../src/context-package.js');
    await expect(
      buildPullRequestPackage({ cwd: tmpdir(), pr: '7', ghBin: '/nonexistent/gh' }),
    ).rejects.toMatchObject({ code: 'GH_NOT_FOUND' });
  });
});
