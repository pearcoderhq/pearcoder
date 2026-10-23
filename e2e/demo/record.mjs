// Records the README / launch demo: two people in one session, each with their own Claude Code.
// The UI is real and the agent step is a real `/pearcoder:dev` run in Claude Code (the developer's
// own login, a few cents on Haiku). Run: pnpm build && node e2e/demo/record.mjs [outDir]
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startLocalNode } from '@pearcoderhq/bridge';
import { joinSession, writeRecord } from '@pearcoderhq/client';
import {
  HostSession,
  loadOrCreateDeviceIdentity,
  recordAttachedAgent,
  writeProfile,
} from '@pearcoderhq/core';
import { startSessionServer } from '@pearcoderhq/server';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const out = resolve(process.argv[2] ?? join(root, 'e2e/demo/out'));
mkdirSync(out, { recursive: true });
const t = (p) => mkdtempSync(join(tmpdir(), p));
const W = 960;
const H = 720;

// Hana hosts; Alice joins. Both attached Claude Code, so each sees the other's agent.
const hanaHome = t('demo-hana-');
const hana = loadOrCreateDeviceIdentity(hanaHome);
writeProfile({ display_name: 'Hana' }, hanaHome);
recordAttachedAgent('claude-code', hanaHome);
const session = HostSession.create({
  identity: hana,
  displayName: 'Hana',
  sessionName: 'payments',
});
const server = await startSessionServer({ sessions: new Map([[session.sessionId, session]]) });
const record = {
  v: 1,
  session_id: session.sessionId,
  session_name: session.sessionName,
  host_user_id: hana.userId,
  host_public_key: hana.publicKey,
  addresses: [server.url],
  joined_at: new Date().toISOString(),
};
writeRecord(hanaHome, { ...record, role: 'host' });
const aliceHome = t('demo-alice-');
const alice = loadOrCreateDeviceIdentity(aliceHome);
writeProfile({ display_name: 'Alice' }, aliceHome);
recordAttachedAgent('claude-code', aliceHome);
const { token } = session.invite({ addresses: [server.url] });
await joinSession(token, alice, 'Alice');
writeRecord(aliceHome, { ...record, role: 'member' });

// Alice's checkout, with a remote her agent may push branches to.
const work = t('demo-work-');
const repo = join(work, 'acme-payments');
const remote = join(work, 'remote', 'acme-payments.git');
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(
  join(repo, 'src', 'retry.ts'),
  `export async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const response = await fetch(url, init);
    if (response.status !== 503) return response;
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 100));
  }
}
`,
);
const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
git('init', '-q', '-b', 'main');
git('add', '.');
git('commit', '-qm', 'retry on 503');
mkdirSync(join(work, 'remote'));
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
git('remote', 'add', 'origin', remote);
git('push', '-q', 'origin', 'main');
git('remote', 'set-head', 'origin', 'main');
git('config', 'user.name', 'Alice');
git('config', 'user.email', 'alice@example.com');

const hanaNode = await startLocalNode({ home: hanaHome, identity: hana });
const aliceNode = await startLocalNode({ home: aliceHome, identity: alice });

const browser = await chromium.launch();
const open = async (who) => {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: join(out, `raw-${who}`), size: { width: W, height: H } },
  });
  const started = Date.now();
  const page = await context.newPage();
  return { context, page, started };
};
const hanaView = await open('hana');
const aliceView = await open('alice');
const hanaPage = hanaView.page;
const alicePage = aliceView.page;
await hanaPage.goto(hanaNode.openUrl);
await alicePage.goto(aliceNode.openUrl);

// A caption bar and a "whose screen" label, drawn into each page.
const caption = async (page, who, text) =>
  page.evaluate(
    ([who, text]) => {
      let bar = document.getElementById('demo-caption');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'demo-caption';
        bar.style.cssText =
          'position:fixed;left:0;right:0;bottom:0;height:64px;box-sizing:border-box;display:flex;align-items:center;z-index:9999;pointer-events:none;padding:0 20px;background:#0f1b2d;color:#fff;font:600 18px/1.3 system-ui,sans-serif';
        // The app keeps its full layout above the caption.
        const style = document.createElement('style');
        style.textContent = '#root > div { height: calc(100dvh - 64px) !important; }';
        document.head.appendChild(style);
        document.body.appendChild(bar);
        const tag = document.createElement('div');
        tag.style.cssText =
          'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9999;pointer-events:none;padding:3px 10px;border-radius:999px;background:#5aa469;color:#fff;font:700 13px system-ui,sans-serif';
        tag.textContent = `${who}'s screen`;
        document.body.appendChild(tag);
      }
      bar.textContent = text;
    },
    [who, text],
  );
const both = (text) =>
  Promise.all([caption(hanaPage, 'Hana', text), caption(alicePage, 'Alice', text)]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const marks = {};
const mark = (name) => {
  marks[name] = Date.now();
};

await hanaPage.getByText("Alice's Claude Code").first().waitFor();
await alicePage.getByText("Hana's Claude Code").first().waitFor();
mark('start');
await both('Hana and Alice share a session. Each brings their own Claude Code.');
await pause(3500);

// Hana gives the work to Alice's agent. It's a request to Alice, not a command.
await caption(hanaPage, 'Hana', "Hana asks Alice's agent for a fix…");
await caption(alicePage, 'Alice', 'Alice sees it first.');
await hanaPage.getByRole('button', { name: 'Create a task' }).click();
await hanaPage.getByLabel('Task title').pressSequentially('Stop retrying forever on 503', {
  delay: 35,
});
await hanaPage.getByLabel('Assign to').selectOption({ label: "Alice's Claude Code" });
await pause(900);
await hanaPage.getByRole('button', { name: 'Create task' }).click();
await alicePage.getByText('This asks your Claude Code. It waits for you.').waitFor();
await pause(1200);
await caption(hanaPage, 'Hana', "…and sees it's waiting for Alice.");
await caption(
  alicePage,
  'Alice',
  "Other people can't steer her agent. She approves, or rewrites it first.",
);
await hanaPage.getByText("Alice's Claude Code: waiting for Alice").waitFor({ timeout: 15_000 });
await pause(2500);

// Alice rewrites the task in her own words and approves it.
await alicePage.getByRole('button', { name: 'Edit and approve' }).click();
const box = alicePage.getByLabel(/Your version/);
await box.fill('');
await box.pressSequentially(
  'In src/retry.ts, stop fetchWithRetry after 3 retries and return the last response. Push it to a branch.',
  { delay: 18 },
);
await pause(600);
await alicePage.getByRole('button', { name: 'Approve my version' }).click();
await hanaPage
  .getByText("Alice's Claude Code: approved with edits by Alice")
  .waitFor({ timeout: 15_000 });
await caption(hanaPage, 'Hana', 'Approved, with edits. Hana never sees Alice’s private wording.');
await caption(alicePage, 'Alice', 'Her own Claude Code picks it up in /pearcoder:dev.');
await pause(2500);

// The real agent run: Alice's own Claude Code, in her terminal, in her checkout.
mark('agentStart');
const cfg = join(t('demo-cfg-'), 'mcp.json');
writeFileSync(
  cfg,
  JSON.stringify({
    mcpServers: {
      pearcoder: {
        command: process.execPath,
        args: [join(root, 'packages/cli/dist/bin.js'), 'mcp'],
        env: { PEARCODER_HOME: aliceHome },
      },
    },
  }),
);
const agent = spawn(
  'claude',
  [
    '-p',
    '/pearcoder:dev once',
    '--model',
    process.env.DEMO_MODEL ?? 'haiku',
    '--plugin-dir',
    join(root, 'integrations/claude-code/plugins/pearcoder'),
    '--mcp-config',
    cfg,
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    '--allowedTools',
    'mcp__pearcoder__*,Edit,Write',
  ],
  { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] },
);
let agentOutput = '';
agent.stdout.on('data', (d) => {
  agentOutput += d;
});
agent.stderr.on('data', (d) => {
  agentOutput += d;
});
await hanaPage
  .getByText(/Alice's Claude Code: working/)
  .waitFor({ timeout: 120_000 })
  .catch(() => undefined);
await both('Working: it edits the code and pushes a branch. Never main, never --force.');
// The local node sends the push notice under Alice's "mine" mode.
await hanaPage
  .getByText("Alice's agent pushed to acme-payments")
  .first()
  .waitFor({ timeout: 240_000 });
mark('agentEnd');
// Its last task_wait idles before returning; that wait is not part of the video.
const agentDone = new Promise((r) => agent.on('close', r));
await both('Only the commit reference travels. Code moves through git, never through Pearcoder.');
await pause(4500);
await both('Nobody runs anyone else’s agent. npx pearcoder · github.com/pearcoderhq/pearcoder');
await pause(4000);
mark('end');
await agentDone;

await hanaView.context.close();
await aliceView.context.close();
await browser.close();
await hanaNode.close();
await aliceNode.close();
await server.close();

const video = (who) => {
  const dir = join(out, `raw-${who}`);
  const file = readdirSync(dir).find((f) => f.endsWith('.webm'));
  const target = join(out, `${who}.webm`);
  renameSync(join(dir, file), target);
  return target;
};
const offset = (view) => (marks.start - view.started) / 1000;
writeFileSync(
  join(out, 'marks.json'),
  JSON.stringify(
    {
      hana: { file: video('hana'), start: offset(hanaView) },
      alice: { file: video('alice'), start: offset(aliceView) },
      agentStart: (marks.agentStart - marks.start) / 1000,
      agentEnd: (marks.agentEnd - marks.start) / 1000,
      end: (marks.end - marks.start) / 1000,
      branch: git('branch', '--list', 'pearcoder/*').replace('*', '').trim(),
    },
    null,
    2,
  ),
);
console.log(agentOutput.slice(-600));
console.log('recorded', out);
