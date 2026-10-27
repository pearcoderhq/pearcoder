import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunningLocalNode, startLocalNode } from '@pearcoderhq/bridge';
import { joinSession, writeRecord } from '@pearcoderhq/client';
import {
  type DeviceIdentity,
  HostSession,
  loadOrCreateDeviceIdentity,
  recordAttachedAgent,
  writeProfile,
} from '@pearcoderhq/core';
import { newEventId, PROTOCOL_VERSION, type SessionId, signEvent } from '@pearcoderhq/protocol';
import { type RunningSessionServer, startSessionServer } from '@pearcoderhq/server';
import { expect, test } from '@playwright/test';

// Building together (ADR-0007) in real browsers: Hana asks Alice's agent for something, Alice
// rewrites and approves it, and Hana sees the state change without ever seeing Alice's text.
// Then a task for Alice's agent, and pushed commits that replace each other.
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearcoder-e2e-dev-'));
  dirs.push(dir);
  return dir;
};

let server: RunningSessionServer;
let hanaNode: RunningLocalNode;
let aliceNode: RunningLocalNode;
let session: HostSession;
let alice: DeviceIdentity;

const append = (who: DeviceIdentity, type: string, payload: Record<string, unknown>) =>
  session.log.append(
    signEvent(
      {
        id: newEventId(),
        session_id: session.sessionId,
        timestamp: new Date().toISOString(),
        actor_user_id: who.userId,
        type,
        thread_id: 'main',
        version: PROTOCOL_VERSION,
        payload,
      },
      who.privateKey,
    ),
  ).event;

test.beforeAll(async () => {
  const hanaHome = temp();
  const hana = loadOrCreateDeviceIdentity(hanaHome);
  writeProfile({ display_name: 'Hana' }, hanaHome);
  session = HostSession.create({ identity: hana, displayName: 'Hana', sessionName: 'retry' });
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

  const aliceHome = temp();
  alice = loadOrCreateDeviceIdentity(aliceHome);
  writeProfile({ display_name: 'Alice' }, aliceHome);
  recordAttachedAgent('claude-code', aliceHome);
  const { token } = session.invite({ addresses: [server.url] });
  await joinSession(token, alice, 'Alice');
  writeRecord(aliceHome, { ...record, role: 'member' });

  hanaNode = await startLocalNode({ home: hanaHome, identity: hana });
  aliceNode = await startLocalNode({ home: aliceHome, identity: alice });
});

test.afterAll(async () => {
  await hanaNode?.close();
  await aliceNode?.close();
  await server?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('edit and approve, tasks for an agent, and pushed commits', async ({ browser }) => {
  const hanaPage = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ).newPage();
  const alicePage = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ).newPage();
  await hanaPage.goto(hanaNode.openUrl);
  await alicePage.goto(aliceNode.openUrl);

  // Alice's agent bar explains both modes; "others" starts off.
  await expect(alicePage.getByText("others' messages wait for your approval")).toBeVisible();
  await alicePage.getByRole('button', { name: 'Settings' }).click();
  await expect(
    alicePage.getByRole('switch', { name: "Others' messages to your agent" }),
  ).toHaveAttribute('aria-checked', 'false');
  await expect(
    alicePage.getByRole('switch', { name: 'Your messages to your agent' }),
  ).toHaveAttribute('aria-checked', 'true');

  // Hana mentions Alice's agent; it waits for Alice, and Hana can see that.
  await expect(hanaPage.getByRole('complementary')).toContainText("Alice's Claude Code");
  await hanaPage
    .getByLabel('Message')
    .fill("@Alice's Claude Code rewrite the retry loop and push it");
  await hanaPage.getByLabel('Message').press('Enter');
  await expect(alicePage.getByText('This asks your Claude Code. It waits for you.')).toBeVisible();
  await expect(hanaPage.getByText("Alice's Claude Code: waiting for Alice")).toBeVisible({
    timeout: 10_000,
  });

  // Alice rewrites it and approves her version.
  await alicePage.getByRole('button', { name: 'Edit and approve' }).click();
  await alicePage.getByLabel(/Your version/).fill('Add a max of 3 retries to fetchWithRetry.');
  await alicePage.getByRole('button', { name: 'Approve my version' }).click();
  await expect(alicePage.getByText('Approved with your edits')).toBeVisible();
  await expect(hanaPage.getByText("Alice's Claude Code: approved with edits by Alice")).toBeVisible(
    {
      timeout: 10_000,
    },
  );
  // Alice's text stays on her machine.
  await expect(hanaPage.getByText('max of 3 retries')).toHaveCount(0);

  // A request for work that mentions nobody reaches no agent: Alice gets a one-click fix to
  // address her own agent. Hana has no agent attached, so she gets no hint.
  const aliceMessage = alicePage.getByLabel('Message', { exact: true });
  const hanaMessage = hanaPage.getByLabel('Message', { exact: true });
  await aliceMessage.fill('fix the flaky retry test');
  await expect(alicePage.getByText('This mentions no one, so no agent will see it.')).toBeVisible();
  await alicePage.getByRole('button', { name: 'Mention your Claude Code' }).click();
  await expect(aliceMessage).toHaveValue("@Alice's Claude Code fix the flaky retry test");
  await expect(alicePage.getByText('This mentions no one, so no agent will see it.')).toHaveCount(
    0,
  );
  await aliceMessage.fill('');
  await hanaMessage.fill('fix the flaky retry test');
  await expect(hanaPage.getByText('This mentions no one, so no agent will see it.')).toHaveCount(0);
  await hanaMessage.fill('');

  // Hana gives Alice's agent a task. Alice decides; Hana is told so.
  await hanaPage.getByRole('button', { name: 'Create a task' }).click();
  await hanaPage.getByLabel('Task title').fill('Add jitter to the backoff');
  await hanaPage.getByLabel('Assign to').selectOption({ label: "Alice's Claude Code" });
  await expect(hanaPage.getByText('Their owner sees this first')).toBeVisible();
  await hanaPage.getByRole('button', { name: 'Create task' }).click();
  await expect(alicePage.getByText('Add jitter to the backoff')).toBeVisible();
  await alicePage.getByRole('button', { name: 'Decline' }).click();
  await expect(alicePage.getByText('You declined this for your Claude Code.')).toBeVisible();
  await expect(hanaPage.getByText("Alice's Claude Code: declined by its owner")).toBeVisible({
    timeout: 10_000,
  });

  // Alice pushes twice to the same branch: the first commit is marked as replaced.
  const ref = (commit: string, summary: string) =>
    append(alice, 'code_ref.published', {
      repo: { name: 'app', url: 'https://github.com/example/app' },
      branch: 'feat/retry',
      commit,
      summary,
    });
  ref('1'.repeat(40), 'First try at the retry cap');
  ref('2'.repeat(40), 'Retry cap with a test');
  await expect(hanaPage.getByText('Alice pushed to app')).toHaveCount(2);
  await expect(hanaPage.getByText('A newer push to feat/retry came later')).toHaveCount(1);
  await expect(hanaPage.getByRole('link', { name: '222222222222' })).toHaveAttribute(
    'href',
    `https://github.com/example/app/commit/${'2'.repeat(40)}`,
  );
  await hanaPage.screenshot({ path: 'test-results/dev-hana.png' });
  await alicePage.screenshot({ path: 'test-results/dev-alice.png' });
});
