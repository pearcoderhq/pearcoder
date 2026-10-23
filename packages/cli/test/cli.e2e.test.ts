// Covers: T05, T06 (through the CLI)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, it } from 'vitest';
import type { Io } from '../src/io.js';
import { main } from '../src/main.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Person {
  home: string;
  out: string[];
  err: string[];
  run(argv: string[]): Promise<number>;
  /** Starts a long-running command; returns a stop function resolving to its exit code. */
  start(argv: string[]): () => Promise<number>;
}

function person(): Person {
  const home = mkdtempSync(join(tmpdir(), 'pearcoder-cli-'));
  dirs.push(home);
  const out: string[] = [];
  const err: string[] = [];
  const io = (signal: AbortSignal): Io => ({
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env: { PEARCODER_HOME: home },
    signal,
    isTTY: false,
  });
  return {
    home,
    out,
    err,
    run: (argv) => main(argv, io(new AbortController().signal)),
    start: (argv) => {
      const controller = new AbortController();
      const done = main(argv, io(controller.signal));
      return () => {
        controller.abort();
        return done;
      };
    },
  };
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await delay(20);
  }
}

const jsonLines = (lines: string[]) =>
  lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('pearcoder CLI', () => {
  it('hosts, invites, joins, says and watches across three people', async () => {
    const hana = person();
    const alice = person();
    const bob = person();

    const stopHost = hana.start([
      'host',
      '--name',
      'auth-review',
      '--as',
      'Hana',
      '--port',
      '0',
      '--no-ui',
      '--json',
    ]);
    await until(() => jsonLines(hana.out).some((l) => l.event === 'hosting'));
    const hosting = jsonLines(hana.out).find((l) => l.event === 'hosting') as {
      invite: string;
      url: string;
    };
    expect(hosting.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    expect(await alice.run(['join', hosting.invite, '--as', 'Alice', '--json'])).toBe(0);
    expect(jsonLines(alice.out).at(-1)).toMatchObject({
      session_name: 'auth-review',
      role: 'member',
    });

    // The first invitation was single-use.
    expect(await bob.run(['join', hosting.invite, '--as', 'Bob'])).toBe(1);
    expect(bob.err.at(-1)).toContain('INVITE_EXHAUSTED');

    expect(await hana.run(['invite', '--role', 'observer', '--json'])).toBe(0);
    const second = jsonLines(hana.out).at(-1) as { invite: string; role: string };
    expect(second.role).toBe('observer');
    expect(await bob.run(['join', second.invite, '--as', 'Bob'])).toBe(0);

    expect(await alice.run(['say', 'is', 'the', 'refresh', 'race', 'real?'])).toBe(0);
    expect(alice.out.at(-1)).toMatch(/^Sent to "auth-review" #[0-9a-f]{8}\.$/);
    expect(await hana.run(['say', 'yes, compare-and-swap'])).toBe(0);

    // Observers can watch but not post.
    expect(await bob.run(['say', 'hello'])).toBe(1);
    expect(bob.err.at(-1)).toContain('FORBIDDEN_FOR_ROLE');

    const stopWatch = bob.start(['watch']);
    await until(() => bob.out.some((l) => l.includes('Hana: yes, compare-and-swap')));
    expect(await stopWatch()).toBe(0);
    const transcript = bob.out.filter((l) => l.startsWith('['));
    // The first line carries the local date; later ones on the same day only the time.
    expect(transcript[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /);
    expect(transcript.map((l) => l.replace(/^\[[^\]]+\] /, ''))).toEqual([
      'Hana joined as host',
      'Alice joined as member',
      'Bob joined as observer',
      'Alice: is the refresh race real?',
      'Hana: yes, compare-and-swap',
    ]);

    const stopJson = alice.start(['watch', '--json']);
    await until(() => jsonLines(alice.out).some((l) => l.type === 'message.created'));
    expect(await stopJson()).toBe(0);

    expect(await stopHost()).toBe(0);
    expect(
      jsonLines(hana.out)
        .filter((l) => l.event === 'participant.joined')
        .map((l) => l.display_name),
    ).toEqual(['Alice', 'Bob']);
  });

  it('reports status and identity as JSON', async () => {
    const solo = person();
    expect(await solo.run(['status', '--json'])).toBe(0);
    expect(jsonLines(solo.out).at(-1)).toEqual({ sessions: [] });
    expect(await solo.run(['whoami', '--set-name', 'Solo', '--json'])).toBe(0);
    expect(jsonLines(solo.out).at(-1)).toMatchObject({
      display_name: 'Solo',
      user_id: expect.stringMatching(/^u_/),
    });
  });

  it('uses exit code 2 and clear messages for usage errors', async () => {
    const p = person();
    expect(await p.run([])).toBe(2);
    expect(await p.run(['dance'])).toBe(2);
    expect(await p.run(['say', 'hi'])).toBe(2);
    expect(p.err.at(-1)).toContain('no sessions yet');
    expect(await p.run(['host', '--name', 'x', '--port', '0'])).toBe(2);
    expect(p.err.at(-1)).toContain('set your name');
    expect(await p.run(['join', 'not-an-invite', '--as', 'P'])).toBe(1);
    expect(p.err.at(-1)).toContain('INVITE_MALFORMED');
    // A failed join does not change the saved name.
    expect(await p.run(['host', '--name', 'x', '--port', '0'])).toBe(2);
    expect(p.err.at(-1)).toContain('set your name');
    expect(await p.run(['publish', 'abc', '--redact', '--allow-secrets'])).toBe(2);
    expect(p.err.at(-1)).toContain('not both');
    expect(await p.run(['--version'])).toBe(0);
    expect(p.out.at(-1)).toMatch(/^\d+\.\d+\.\d+/);
    expect(await p.run(['host', '--bogus'])).toBe(2);
    expect(await p.run(['--help'])).toBe(0);
    expect(p.out.at(-1)).toContain('Usage: pearcoder <command>');
  });

  it('forgets a session that ended: the host on stop, joiners with forget', async () => {
    const hana = person();
    const alice = person();
    const stop = hana.start([
      'host',
      '--name',
      'brief',
      '--as',
      'Hana',
      '--port',
      '0',
      '--no-ui',
      '--json',
    ]);
    await until(() => jsonLines(hana.out).some((l) => l.event === 'hosting'));
    const { invite } = jsonLines(hana.out).find((l) => l.event === 'hosting') as { invite: string };
    expect(await alice.run(['join', invite, '--as', 'Alice'])).toBe(0);
    expect(await stop()).toBe(0);

    expect(await hana.run(['status', '--json'])).toBe(0);
    expect(jsonLines(hana.out).at(-1)).toEqual({ sessions: [] });
    expect(await alice.run(['status'])).toBe(0);
    expect(alice.out.join('\n')).toContain('(not reachable: host stopped or offline)');
    expect(await alice.run(['forget', 'brief'])).toBe(0);
    expect(await alice.run(['status', '--json'])).toBe(0);
    expect(jsonLines(alice.out).at(-1)).toEqual({ sessions: [] });
  });

  it('refuses to invite from a session the user only joined', async () => {
    const host = person();
    const guest = person();
    const stop = host.start([
      'host',
      '--name',
      'review',
      '--as',
      'H',
      '--port',
      '0',
      '--no-ui',
      '--json',
    ]);
    await until(() => jsonLines(host.out).some((l) => l.event === 'hosting'));
    const { invite } = jsonLines(host.out).find((l) => l.event === 'hosting') as { invite: string };
    expect(await guest.run(['join', invite, '--as', 'G'])).toBe(0);
    expect(await guest.run(['invite'])).toBe(2);
    expect(guest.err.at(-1)).toContain('only the host can invite');
    await stop();
  });
});

describe('review workflow commands', () => {
  it('shares a package, requests a review, shows the inbox and resolves it', async () => {
    const hana = person();
    const alice = person();
    const repoDir = mkdtempSync(join(tmpdir(), 'pearcoder-cli-repo-'));
    dirs.push(repoDir);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(repoDir, 'spec.md'), '# Auth spec\nRotate refresh tokens.\n');

    const stop = hana.start([
      'host',
      '--name',
      'review',
      '--as',
      'Hana',
      '--port',
      '0',
      '--no-ui',
      '--json',
    ]);
    await until(() => jsonLines(hana.out).some((l) => l.event === 'hosting'));
    const { invite } = jsonLines(hana.out).find((l) => l.event === 'hosting') as { invite: string };
    expect(await alice.run(['join', invite, '--as', 'Alice'])).toBe(0);

    const shareIo = (argv: string[]) => {
      const env = { PEARCODER_HOME: hana.home, PWD: repoDir };
      return main(argv, {
        stdout: (l) => hana.out.push(l),
        stderr: (l) => hana.err.push(l),
        env,
        signal: new AbortController().signal,
        isTTY: false,
      });
    };
    expect(await shareIo(['share', 'spec.md', '--objective', 'Find races', '--json'])).toBe(0);
    const shared = jsonLines(hana.out).at(-1) as { id: string; hash: string };
    expect(shared.hash).toMatch(/^sha256:/);

    expect(
      await hana.run(['request', '--to', 'Alice', '--package', 'latest', 'Review the auth spec']),
    ).toBe(0);
    expect(hana.out.at(-1)).toContain('their agents are not started');
    expect(await hana.run(['request', '--to', 'Nobody', 'x'])).toBe(2);

    expect(await alice.run(['inbox', '--json'])).toBe(0);
    const { requests } = jsonLines(alice.out).at(-1) as {
      requests: { id: string; title: string; from_name: string; context_package: string }[];
    };
    expect(requests).toEqual([
      expect.objectContaining({
        title: 'Review the auth spec',
        from_name: 'Hana',
        context_package: shared.id,
      }),
    ]);

    expect(await alice.run(['resolve', requests[0]?.id ?? '', 'accepted', '--note', 'on it'])).toBe(
      0,
    );
    expect(await alice.run(['inbox'])).toBe(0);
    expect(alice.out.at(-1)).toBe('Inbox empty.');

    // An @mention reaches the person's inbox until they reply.
    expect(await hana.run(['say', '@Alice can you look at rotate()?'])).toBe(0);
    expect(hana.out.at(-1)).toContain('(mentions 1; it shows in their inbox)');
    expect(await alice.run(['inbox'])).toBe(0);
    expect(alice.out.join('\n')).toMatch(/Hana mentioned you: @Alice can you look at rotate\(\)\?/);
    const mention = /^([0-9a-f]{8}) +\[/m.exec(alice.out.join('\n'))?.[1];
    expect(await alice.run(['say', '--reply', mention ?? '', 'looking now'])).toBe(0);
    expect(await alice.run(['inbox'])).toBe(0);
    expect(alice.out.at(-1)).toBe('Inbox empty.');

    // Asking someone's agent, yourself included, is a request in their inbox, nothing more.
    expect(
      await hana.run(['request', '--to', 'Hana', '--for-agent', 'claude', 'Review the auth spec']),
    ).toBe(0);
    expect(hana.out.at(-1)).toMatch(/Asked Hana to use their Claude Code: .* #[0-9a-f]{8}\./);
    expect(await hana.run(['inbox'])).toBe(0);
    expect(hana.out.join('\n')).toMatch(
      /review \(for your Claude Code\) from Hana: Review the auth spec/,
    );
    expect(hana.out.join('\n')).toMatch(/in Claude Code: \/pearcoder:review [0-9a-f]{8}/);
    expect(await hana.run(['request', '--to', 'Hana', '--for-agent', 'gpt', 'x'])).toBe(2);
    await stop();
  });

  it('blocks sharing secrets unless redacted', async () => {
    const hana = person();
    const repoDir = mkdtempSync(join(tmpdir(), 'pearcoder-cli-repo-'));
    dirs.push(repoDir);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(repoDir, 'notes.md'), `# Notes\ntoken ghp_${'k'.repeat(36)}\n`);
    const run = (argv: string[]) =>
      main(argv, {
        stdout: (l) => hana.out.push(l),
        stderr: (l) => hana.err.push(l),
        env: { PEARCODER_HOME: hana.home, PWD: repoDir },
        signal: new AbortController().signal,
        isTTY: false,
      });
    expect(await run(['share', 'notes.md', '--objective', 'o', '--dry-run'])).toBe(1);
    expect(hana.err.join('\n')).toContain('github token');
    expect(
      await run(['share', 'notes.md', '--objective', 'o', '--dry-run', '--redact', '--json']),
    ).toBe(0);
    const payload = JSON.parse(hana.out.at(-1) ?? '{}') as { body: string };
    expect(payload.body).toContain('[redacted github token]');
  });
});

describe('attach and doctor', () => {
  it('prints the Claude Code setup without touching permissions', async () => {
    const p = person();
    expect(await p.run(['attach', '--agent', 'claude', '--dry-run'])).toBe(0);
    const lines = p.out.join('\n');
    expect(lines).toContain('mcp add --scope user -e PEARCODER_HOME=');
    expect(lines).toMatch(/pearcoder -- \S+ \S+dist[\\/]bin\.js mcp/);
    expect(lines).toContain('plugin marketplace add');
    expect(lines).toContain('plugin install pearcoder@pearcoder --scope user');
    expect(lines).not.toMatch(/permission|allow/i);
    expect(await p.run(['attach', '--agent', 'codex'])).toBe(2);
  });

  it.runIf(process.platform !== 'win32')(
    'runs the claude commands and reports with doctor',
    async () => {
      const { writeFileSync, chmodSync, readFileSync } = await import('node:fs');
      const p = person();
      const log = join(p.home, 'claude-calls.log');
      const fake = join(p.home, 'claude');
      writeFileSync(
        fake,
        `#!/bin/sh\necho "$@" >> "${log}"\ncase "$1" in\n  --version) echo "2.1.308 (Claude Code)";;\n  plugin) [ "$2" = list ] && echo "pearcoder@pearcoder";;\nesac\nexit 0\n`,
      );
      chmodSync(fake, 0o755);
      const io = (signal = new AbortController().signal) => ({
        stdout: (l: string) => p.out.push(l),
        stderr: (l: string) => p.err.push(l),
        env: {
          PEARCODER_HOME: p.home,
          PEARCODER_CLAUDE_BIN: fake,
          PEARCODER_CODEX_BIN: '/nonexistent/codex',
        },
        signal,
        isTTY: false,
      });
      expect(await main(['attach', '--agent', 'claude'], io())).toBe(0);
      const calls = readFileSync(log, 'utf8');
      expect(calls).toContain('mcp add --scope user');
      expect(calls).toContain('plugin install pearcoder@pearcoder --scope user');
      expect(p.out.join('\n')).toContain('always allow');

      expect(await main(['whoami', '--set-name', 'Doc'], io())).toBe(0);
      expect(await main(['doctor', '--json'], io())).toBe(0);
      const { checks } = JSON.parse(p.out.at(-1) ?? '{}') as {
        checks: { name: string; ok: boolean }[];
      };
      expect(checks.map((c) => c.name)).toEqual([
        'identity',
        'name',
        'claude code',
        'mcp server',
        'plugin',
      ]);
      expect(checks.every((c) => c.ok)).toBe(true);
    },
  );
});

describe('outcome commands', () => {
  it('drafts → publish → reply → resolve → decide → vote → export → verify', async () => {
    const { createDraft } = await import('@pearcoderhq/bridge');
    const hana = person();
    const alice = person();
    const stop = hana.start([
      'host',
      '--name',
      'outcome',
      '--as',
      'Hana',
      '--port',
      '0',
      '--no-ui',
      '--json',
    ]);
    await until(() => jsonLines(hana.out).some((l) => l.event === 'hosting'));
    const hosting = jsonLines(hana.out).find((l) => l.event === 'hosting') as {
      invite: string;
      session_id: string;
    };
    expect(await alice.run(['join', hosting.invite, '--as', 'Alice'])).toBe(0);

    // Alice's agent left a draft; she reviews and publishes it.
    createDraft(alice.home, {
      sessionId: hosting.session_id,
      source: { via: 'mcp', harness: 'claude-code' },
      payload: { title: 'Race in rotate()', severity: 'high', body: 'check-then-act' },
    });
    expect(await alice.run(['drafts', '--json'])).toBe(0);
    const [draft] = (jsonLines(alice.out).at(-1) as { drafts: { id: string }[] }).drafts;
    expect(await alice.run(['drafts', draft?.id.slice(0, 8) ?? ''])).toBe(0);
    expect(alice.out.join('\n')).toContain('HIGH: Race in rotate()');
    expect(await alice.run(['publish', draft?.id.slice(0, 8) ?? '', '--json'])).toBe(0);
    const published = jsonLines(alice.out).at(-1) as { event: string };
    expect(await alice.run(['publish', draft?.id.slice(0, 8) ?? ''])).toBe(1);

    expect(await hana.run(['resolve', published.event.slice(0, 8), 'fixed', '--note', 'CAS'])).toBe(
      0,
    );
    expect(await hana.run(['resolve', published.event, 'done'])).toBe(2);

    expect(
      await hana.run([
        'decide',
        'Use CAS for rotation',
        '--decision',
        'Conditional UPDATE',
        '--related',
        published.event,
        '--json',
      ]),
    ).toBe(0);
    const decision = jsonLines(hana.out).at(-1) as { id: string };
    expect(await alice.run(['vote', decision.id.slice(0, 8), 'agree', '--note', 'simplest'])).toBe(
      0,
    );
    expect(await alice.run(['resolve', decision.id, 'accepted'])).toBe(1);
    expect(alice.err.at(-1)).toContain('NOT_ADDRESSEE');
    expect(await hana.run(['resolve', decision.id, 'accepted', '--note', 'ship in 1.2'])).toBe(0);
    // Once an outcome is recorded, the host takes no more stances.
    expect(await alice.run(['vote', decision.id.slice(0, 8), 'disagree'])).toBe(1);
    expect(alice.err.at(-1)).toContain('DECISION_CLOSED');

    // Listings, with short ids that the other commands accept.
    expect(await alice.run(['findings'])).toBe(0);
    expect(alice.out.at(-1)).toContain('No open findings');
    expect(await alice.run(['findings', '--all'])).toBe(0);
    expect(alice.out.join('\n')).toMatch(
      new RegExp(
        `${published.event.slice(0, 8)}  high +fixed +Race in rotate\\(\\)  by Alice \\(agent\\)`,
      ),
    );
    expect(await alice.run(['decisions'])).toBe(0);
    expect(alice.out.join('\n')).toContain(
      `${decision.id.slice(0, 8)}  accepted   Use CAS for rotation  by Hana`,
    );
    expect(alice.out.join('\n')).toContain('[Alice agree]');

    expect(await hana.run(['export'])).toBe(0);
    const md = hana.out.slice(-1)[0] ?? '';
    expect(md).toContain('# Review: outcome');
    expect(md).toContain("Alice's agent · **fixed (Hana)**");
    expect(md).toContain('### Use CAS for rotation (accepted by Hana)');
    expect(md).toContain('**Stances.** Alice: agree (simplest)');
    expect(md).toContain('**Addresses.** [HIGH] Race in rotate()');
    expect(md).toContain('**Outcome note.** ship in 1.2');

    const file = join(hana.home, 'session.jsonl');
    expect(await hana.run(['export', '--format', 'jsonl', '--out', file])).toBe(0);
    expect(await alice.run(['verify', file])).toBe(0);
    expect(alice.out.at(-1)).toMatch(/^OK: \d+ events/);
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('Conditional UPDATE', 'Serializable transaction'),
    );
    expect(await alice.run(['verify', file])).toBe(1);
    await stop();
  });
});

describe('persistent hosting', () => {
  it('survives a host restart with history, members and invitations', async () => {
    const hana = person();
    const alice = person();
    const bob = person();
    let stop = hana.start([
      'host',
      '--name',
      'durable',
      '--as',
      'Hana',
      '--port',
      '0',
      '--persist',
      '--no-ui',
      '--json',
    ]);
    await until(() => jsonLines(hana.out).some((l) => l.event === 'hosting'));
    const first = jsonLines(hana.out).find((l) => l.event === 'hosting') as {
      invite: string;
      url: string;
    };
    expect(await alice.run(['join', first.invite, '--as', 'Alice'])).toBe(0);
    expect(await hana.run(['invite', '--uses', '1', '--json'])).toBe(0);
    const spare = (jsonLines(hana.out).at(-1) as { invite: string }).invite;
    expect(await alice.run(['say', 'before the restart'])).toBe(0);
    expect(await stop()).toBe(0);

    stop = hana.start(['host', '--resume', 'durable', '--no-ui', '--json']);
    await until(() => jsonLines(hana.out).filter((l) => l.event === 'hosting').length === 2);
    const second = jsonLines(hana.out).filter((l) => l.event === 'hosting')[1] as {
      url: string;
      session_id: string;
    };
    expect(second.url).toBe(first.url);

    // A second host process would fork the history, and a new session must not reuse the name.
    expect(await hana.run(['host', '--resume', 'durable', '--no-ui', '--json'])).not.toBe(0);
    expect(hana.err.join('\n')).toMatch(/already being hosted/);
    expect(
      await hana.run([
        'host',
        '--name',
        'Durable',
        '--persist',
        '--port',
        '0',
        '--no-ui',
        '--json',
      ]),
    ).not.toBe(0);
    expect(hana.err.join('\n')).toMatch(/--resume "Durable"/);

    // Alice is still a member, and an invitation issued before the restart still works.
    const said = await alice.run(['say', 'after the restart']);
    expect({ said, err: said ? alice.err : [] }).toEqual({ said: 0, err: [] });
    expect(await bob.run(['join', spare, '--as', 'Bob'])).toBe(0);
    const watch = bob.start(['watch']);
    await until(() => bob.out.some((l) => l.includes('Alice: after the restart')));
    await watch();
    const lines = bob.out.filter((l) => l.startsWith('['));
    expect(lines.some((l) => l.includes('Alice: before the restart'))).toBe(true);
    expect(lines.filter((l) => l.includes('Hana joined as host'))).toHaveLength(1);
    expect(await stop()).toBe(0);
  });
});

describe('attach --agent codex', () => {
  it.runIf(process.platform !== 'win32')(
    'registers the MCP server and installs only Pearcoder files',
    async () => {
      const { writeFileSync, chmodSync, readFileSync, existsSync } = await import('node:fs');
      const p = person();
      const log = join(p.home, 'codex-calls.log');
      const fake = join(p.home, 'codex');
      writeFileSync(
        fake,
        `#!/bin/sh\necho "$@" >> "${log}"\n[ "$1" = --version ] && echo "codex-cli 0.160.0"\nexit 0\n`,
      );
      chmodSync(fake, 0o755);
      const userHome = join(p.home, 'user');
      const codexHome = join(userHome, '.codex');
      const io = {
        stdout: (l: string) => p.out.push(l),
        stderr: (l: string) => p.err.push(l),
        env: {
          PEARCODER_HOME: p.home,
          PEARCODER_CODEX_BIN: fake,
          HOME: userHome,
          CODEX_HOME: codexHome,
        },
        signal: new AbortController().signal,
        isTTY: false,
      };
      expect(await main(['attach', '--agent', 'codex', '--dry-run'], io)).toBe(0);
      expect(p.out.join('\n')).toContain(
        `install ${join(codexHome, 'agents', 'pearcoder-reviewer.toml')}`,
      );
      expect(await main(['attach', '--agent', 'codex'], io)).toBe(0);
      const calls = readFileSync(log, 'utf8');
      expect(calls).toMatch(/mcp add --env PEARCODER_HOME=\S+ pearcoder -- \S+ \S+ mcp/);
      const agent = readFileSync(join(codexHome, 'agents', 'pearcoder-reviewer.toml'), 'utf8');
      expect(agent).toContain('name = "pearcoder-reviewer"');
      expect(agent).toMatch(/\[features\][\s\S]*apps = false/);
      expect(existsSync(join(userHome, '.agents', 'skills', 'pearcoder-review', 'SKILL.md'))).toBe(
        true,
      );
      expect(p.out.join('\n')).toContain('--sandbox read-only');
    },
  );
});
