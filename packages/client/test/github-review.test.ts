// Covers: GitHub review export (findings leave the session only when the owner posts them)
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostSession, loadOrCreateDeviceIdentity } from '@pearcoderhq/core';
import {
  newEventId,
  PROTOCOL_VERSION,
  signEvent,
  withContextPackageHash,
} from '@pearcoderhq/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { commentableLines, planGithubReview, postGithubReview } from '../src/github-review.js';

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const DIFF = `diff --git a/src/token.ts b/src/token.ts
index 1111111..2222222 100644
--- a/src/token.ts
+++ b/src/token.ts
@@ -1,4 +1,5 @@
 import { db } from './db.js';
-export async function rotate(old: string) {
+export async function rotate(old: string): Promise<string> {
+  const row = await db.get(old);
   if (!row) throw new Error('invalid');
 }
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-export {};
`;

describe('commentableLines', () => {
  it('maps new-side lines in each hunk, skipping removed lines and deleted files', () => {
    const lines = commentableLines(DIFF);
    expect([...(lines.get('src/token.ts') ?? [])]).toEqual([1, 2, 3, 4, 5]);
    expect(lines.has('src/gone.ts')).toBe(false);
  });
});

describe.runIf(process.platform !== 'win32')('GitHub review', () => {
  const head = 'c'.repeat(40);
  function fakeGh() {
    const dir = temp('pearcoder-gh-review-');
    writeFileSync(join(dir, 'diff.txt'), DIFF);
    const bin = join(dir, 'gh');
    writeFileSync(
      bin,
      `#!/bin/sh
case "$1 $2" in
  "pr view") echo '{"number":7,"url":"https://github.com/acme/auth/pull/7"}';;
  "pr diff") cat "${dir}/diff.txt";;
  "api repos/acme/auth/pulls/7") echo '{"head":{"sha":"${head}"}}';;
  "api --method") cp "$6" "${dir}/posted.json"; echo '{"html_url":"https://github.com/acme/auth/pull/7#pullrequestreview-1"}';;
  *) echo "unexpected: $@" >&2; exit 1;;
esac
`,
    );
    chmodSync(bin, 0o755);
    return { bin, posted: () => JSON.parse(readFileSync(join(dir, 'posted.json'), 'utf8')) };
  }

  function session() {
    const hana = loadOrCreateDeviceIdentity(temp('pearcoder-gh-hana-'));
    const s = HostSession.create({ identity: hana, displayName: 'Hana', sessionName: 'pr-7' });
    const append = (type: string, payload: Record<string, unknown>) =>
      s.log.append(
        signEvent(
          {
            id: newEventId(),
            session_id: s.sessionId,
            timestamp: new Date().toISOString(),
            actor_user_id: hana.userId,
            type,
            thread_id: 'main',
            version: PROTOCOL_VERSION,
            payload,
          },
          hana.privateKey,
        ),
      ).event;
    const pkg = append(
      'context_package.published',
      withContextPackageHash({
        title: 'PR #7: Rotate tokens',
        objective: 'Races',
        constraints: [],
        repo: {
          name: 'acme/auth',
          url: 'https://github.com/acme/auth/pull/7',
          head: 'b'.repeat(40),
        },
        paths: ['src/token.ts'],
        excerpts: [],
        body: 'diff',
      }),
    );
    const request = append('request.created', {
      to: [hana.userId],
      kind: 'review',
      title: 'Review PR 7',
      context_package: pkg.id,
    });
    const finding = (title: string, severity: string, extra: Record<string, unknown>) =>
      append('review.finding', { title, severity, body: `${title} details`, ...extra });
    const inline = finding('Race between read and update', 'high', {
      request: request.id,
      location: { path: 'src/token.ts', start_line: 3, end_line: 4 },
    });
    const offDiff = finding(`Missing index ghp_${'q'.repeat(36)}`, 'low', {
      context_package: pkg.id,
      location: { path: 'src/db.ts', start_line: 99 },
    });
    const fixed = finding('Typo', 'info', { context_package: pkg.id });
    append('finding.resolved', { finding: fixed.id, resolution: 'fixed' });
    finding('Unrelated', 'critical', {});
    return { events: s.log.after(0), inline, offDiff, fixed };
  }

  it('plans inline comments for lines in the diff and puts the rest in the body', async () => {
    const gh = fakeGh();
    const { events, inline, offDiff } = session();
    const plan = await planGithubReview(events, { cwd: tmpdir(), pr: '7', ghBin: gh.bin });
    expect(plan).toMatchObject({ repo: 'acme/auth', number: 7, commitId: head });
    expect(plan.findings).toEqual([inline.id, offDiff.id]);
    expect(plan.comments).toEqual([
      expect.objectContaining({ path: 'src/token.ts', line: 4, start_line: 3, side: 'RIGHT' }),
    ]);
    expect(plan.comments[0]?.body).toContain('**[HIGH] Race between read and update**');
    expect(plan.comments[0]?.body).toContain('Hana, via Pearcoder');
    expect(plan.body).toContain('2 findings (1 inline)');
    expect(plan.body).toContain('the PR has moved since');
    expect(plan.body).toContain('`src/db.ts:99`');
    expect(plan.body).not.toContain('Unrelated');
    // Allowed into the session is not allowed onto GitHub.
    expect(plan.redacted).toBeGreaterThan(0);
    expect(JSON.stringify(plan)).not.toContain(`ghp_${'q'.repeat(36)}`);

    const all = await planGithubReview(events, {
      cwd: tmpdir(),
      pr: '7',
      ghBin: gh.bin,
      includeResolved: true,
    });
    expect(all.body).toContain('_(fixed in the session)_');
  });

  it('posts one COMMENT review, never an approval', async () => {
    const gh = fakeGh();
    const plan = await planGithubReview(session().events, {
      cwd: tmpdir(),
      pr: '7',
      ghBin: gh.bin,
    });
    const result = await postGithubReview(plan, { cwd: tmpdir(), ghBin: gh.bin });
    expect(result.url).toContain('pullrequestreview-1');
    expect(gh.posted()).toMatchObject({ event: 'COMMENT', commit_id: head, body: plan.body });
    expect(gh.posted().comments).toHaveLength(1);
  });

  it('asks to share the PR first when the session has no package for it', async () => {
    const gh = fakeGh();
    const hana = loadOrCreateDeviceIdentity(temp('pearcoder-gh-empty-'));
    const s = HostSession.create({ identity: hana, displayName: 'Hana', sessionName: 'empty' });
    await expect(
      planGithubReview(s.log.after(0), { cwd: tmpdir(), pr: '7', ghBin: gh.bin }),
    ).rejects.toThrow(/pearcoder share --pr 7/);
  });
});
