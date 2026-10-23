import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft, type RunningLocalNode, startLocalNode } from '@pearcoderhq/bridge';
import { joinSession, writeRecord } from '@pearcoderhq/client';
import { HostSession, loadOrCreateDeviceIdentity, writeProfile } from '@pearcoderhq/core';
import {
  newEventId,
  PROTOCOL_VERSION,
  type SessionId,
  signEvent,
  withContextPackageHash,
} from '@pearcoderhq/protocol';
import { type RunningSessionServer, startSessionServer } from '@pearcoderhq/server';
import { expect, test } from '@playwright/test';

// The M2 flow in real browsers: request → inbox → copy prompt → (agent drafts) → owner reviews the
// draft, sees the secret warning, publishes redacted → the requester sees the finding.
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearcoder-e2e-review-'));
  dirs.push(dir);
  return dir;
};

let server: RunningSessionServer;
let hanaNode: RunningLocalNode;
let aliceNode: RunningLocalNode;
let session: HostSession;
let aliceHome: string;

test.beforeAll(async () => {
  const hanaHome = temp();
  const hana = loadOrCreateDeviceIdentity(hanaHome);
  writeProfile({ display_name: 'Hana' }, hanaHome);
  session = HostSession.create({
    identity: hana,
    displayName: 'Hana',
    sessionName: 'auth-redesign',
  });
  server = await startSessionServer({
    sessions: new Map<SessionId, HostSession>([[session.sessionId, session]]),
  });
  const record = {
    v: 1 as const,
    session_id: session.sessionId,
    session_name: session.sessionName,
    host_user_id: hana.userId,
    host_public_key: hana.publicKey,
    addresses: [server.url],
    joined_at: new Date().toISOString(),
  };
  writeRecord(hanaHome, { ...record, role: 'host' });

  aliceHome = temp();
  const alice = loadOrCreateDeviceIdentity(aliceHome);
  writeProfile({ display_name: 'Alice' }, aliceHome);
  const { token } = session.invite({ addresses: [server.url] });
  await joinSession(token, alice, 'Alice');
  writeRecord(aliceHome, { ...record, role: 'member' });

  session.log.append(
    signEvent(
      {
        id: newEventId(),
        session_id: session.sessionId,
        timestamp: new Date().toISOString(),
        actor_user_id: hana.userId,
        type: 'context_package.published',
        thread_id: 'main',
        version: PROTOCOL_VERSION,
        payload: withContextPackageHash({
          title: 'Token rotation spec',
          objective: 'Find races in refresh token rotation',
          constraints: [],
          paths: ['src/token.ts'],
          excerpts: [],
          body: '# Token rotation\nRefresh tokens rotate on every use.',
        }),
      },
      hana.privateKey,
    ),
  );

  hanaNode = await startLocalNode({ home: hanaHome, identity: hana });
  aliceNode = await startLocalNode({ home: aliceHome, identity: alice });
});

test.afterAll(async () => {
  await hanaNode?.close();
  await aliceNode?.close();
  await server?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('request, review prompt, private draft, redacted publish', async ({ browser }) => {
  const hanaPage = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ).newPage();
  const aliceContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const alicePage = await aliceContext.newPage();
  await hanaPage.goto(hanaNode.openUrl);
  await alicePage.goto(aliceNode.openUrl);
  await expect(hanaPage.getByText('Token rotation spec')).toBeVisible();

  // Hana asks Alice for a review, linking the package.
  await hanaPage.getByRole('button', { name: 'Ask someone for a review' }).click();
  await hanaPage.getByLabel('Alice').check();
  await hanaPage.getByLabel('Request title').fill('Review the token rotation spec');
  await hanaPage.getByRole('button', { name: 'Send request' }).click();

  // Alice sees it in her inbox and copies the prompt for her own Claude Code.
  const sidebar = alicePage.getByRole('complementary');
  await expect(sidebar).toContainText('Inbox (1)');
  await expect(sidebar).toContainText('Review the token rotation spec');
  await alicePage.getByRole('button', { name: 'Copy review prompt' }).click();
  const prompt = await alicePage.evaluate(() => navigator.clipboard.readText());
  expect(prompt).toMatch(/^\/pearcoder:review [0-9a-f]{8}$/);
  await alicePage.getByRole('button', { name: 'Accept' }).click();
  await expect(hanaPage.getByText('Alice: accepted')).toBeVisible();
  await expect(sidebar).toContainText('Nothing waiting for you.');

  // Her agent (via MCP) saves a draft that accidentally includes a token.
  createDraft(aliceHome, {
    sessionId: session.sessionId,
    source: { via: 'mcp', harness: 'claude-code' },
    payload: {
      title: 'rotate() is check-then-act',
      severity: 'high',
      body: `Two concurrent calls both pass the revoked check. Repro used ghp_${'x'.repeat(36)}.`,
      request: session.log.after(0).find((e) => e.type === 'request.created')?.id,
      location: { path: 'src/token.ts', start_line: 3 },
    },
  });
  await expect(alicePage.getByRole('button', { name: 'Drafts (1)' })).toBeVisible({
    timeout: 10_000,
  });
  await alicePage.getByRole('button', { name: 'Drafts (1)' }).click();
  await alicePage.getByRole('dialog').getByText('rotate() is check-then-act').click();
  await expect(alicePage.getByRole('alert')).toContainText('github token');
  await alicePage.screenshot({ path: 'test-results/review-alice-draft.png' });
  await alicePage.getByRole('button', { name: 'Publish redacted' }).click();
  await expect(alicePage.getByRole('dialog')).toContainText('No drafts.');

  // Hana sees the published finding, attributed to Alice's agent, with the token redacted.
  await expect(hanaPage.getByText('rotate() is check-then-act')).toBeVisible();
  await expect(hanaPage.getByText('[redacted github token]')).toBeVisible();
  await expect(hanaPage.getByText("Alice's agent (published by them)")).toBeVisible();
  await expect(hanaPage.getByText('ghp_')).toHaveCount(0);
  await hanaPage.screenshot({ path: 'test-results/review-hana.png' });
});

test('reply, resolve, decide, vote and export from the UI', async ({ browser }) => {
  const hanaContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const hanaPage = await hanaContext.newPage();
  const alicePage = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  await hanaPage.goto(hanaNode.openUrl);
  await alicePage.goto(aliceNode.openUrl);
  await expect(hanaPage.getByText('rotate() is check-then-act')).toBeVisible();

  // Hana discusses and resolves the finding Alice published in the first test.
  await hanaPage
    .getByLabel('Reply to rotate() is check-then-act')
    .fill('Agreed. Fixing with a conditional UPDATE.');
  await hanaPage.getByLabel('Reply to rotate() is check-then-act').press('Enter');
  await expect(alicePage.getByText('Agreed. Fixing with a conditional UPDATE.')).toBeVisible();
  await hanaPage.getByLabel('Resolve finding').selectOption('fixed');
  await expect(alicePage.getByText(/^Fixed · Hana/)).toBeVisible();

  // Hana proposes a decision; Alice agrees; Hana accepts it.
  await hanaPage.getByRole('button', { name: 'Propose a decision' }).click();
  await hanaPage.getByLabel('Decision title').fill('Use compare-and-swap for token rotation');
  await hanaPage
    .getByLabel('Decision', { exact: true })
    .fill('Claim the old token with UPDATE … WHERE revoked = 0 and check the row count.');
  await hanaPage.getByRole('button', { name: 'Propose', exact: true }).click();
  await alicePage.getByRole('button', { name: 'agree', exact: true }).click();
  await expect(hanaPage.getByText('Alice: agree')).toBeVisible();
  await expect(alicePage.getByRole('button', { name: 'Accept decision' })).toHaveCount(0);
  await hanaPage.getByRole('button', { name: 'Accept decision' }).click();
  await expect(alicePage.getByText('accepted', { exact: true })).toBeVisible();
  await hanaPage.screenshot({ path: 'test-results/outcomes-hana.png', fullPage: true });

  const download = hanaPage.waitForEvent('download');
  await hanaPage.getByRole('button', { name: 'Export' }).click();
  const file = await (await download).path();
  const { readFileSync } = await import('node:fs');
  const md = readFileSync(file, 'utf8');
  expect(md).toContain('# Review: auth-redesign');
  expect(md).toContain('**fixed (Hana)**');
  expect(md).toContain('- Hana: Agreed. Fixing with a conditional UPDATE.');
  expect(md).toContain('### Use compare-and-swap for token rotation (accepted by Hana)');
  expect(md).toContain('- [ ] Implement: Use compare-and-swap for token rotation');
});
