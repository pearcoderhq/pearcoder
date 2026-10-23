import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunningLocalNode, startLocalNode } from '@pearcoderhq/bridge';
import { joinSession, writeRecord } from '@pearcoderhq/client';
import { HostSession, loadOrCreateDeviceIdentity, writeProfile } from '@pearcoderhq/core';
import type { SessionId } from '@pearcoderhq/protocol';
import { type RunningSessionServer, startSessionServer } from '@pearcoderhq/server';
import { expect, test } from '@playwright/test';

// Two people, each with their own device identity, local node and browser, chatting through a
// session hosted by the first one: the M1 exit flow, end to end in real browsers.
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearcoder-e2e-'));
  dirs.push(dir);
  return dir;
};

let server: RunningSessionServer;
let hanaNode: RunningLocalNode;
let aliceNode: RunningLocalNode;

test.beforeAll(async () => {
  const hanaHome = temp();
  const hana = loadOrCreateDeviceIdentity(hanaHome);
  writeProfile({ display_name: 'Hana' }, hanaHome);
  const session = HostSession.create({
    identity: hana,
    displayName: 'Hana',
    sessionName: 'auth-redesign',
  });
  server = await startSessionServer({
    sessions: new Map<SessionId, HostSession>([[session.sessionId, session]]),
  });
  writeRecord(hanaHome, {
    v: 1,
    session_id: session.sessionId,
    session_name: session.sessionName,
    host_user_id: hana.userId,
    host_public_key: hana.publicKey,
    role: 'host',
    addresses: [server.url],
    joined_at: new Date().toISOString(),
  });

  const aliceHome = temp();
  const alice = loadOrCreateDeviceIdentity(aliceHome);
  writeProfile({ display_name: 'Alice' }, aliceHome);
  const { token } = session.invite({ addresses: [server.url] });
  const joined = await joinSession(token, alice, 'Alice');
  writeRecord(aliceHome, {
    v: 1,
    session_id: joined.host.session_id,
    session_name: joined.host.session_name,
    host_user_id: joined.host.host_user_id,
    host_public_key: joined.host.host_public_key,
    role: joined.host.role,
    addresses: joined.host.addresses,
    joined_at: new Date().toISOString(),
  });

  hanaNode = await startLocalNode({ home: hanaHome, identity: hana });
  aliceNode = await startLocalNode({ home: aliceHome, identity: alice });
});

test.afterAll(async () => {
  await hanaNode?.close();
  await aliceNode?.close();
  await server?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('two people chat through their own local nodes', async ({ browser }) => {
  const hanaPage = await (await browser.newContext()).newPage();
  const alicePage = await (await browser.newContext()).newPage();
  await hanaPage.goto(hanaNode.openUrl);
  await alicePage.goto(aliceNode.openUrl);

  // The owner token is removed from the address bar after load.
  await expect(hanaPage).toHaveURL(`${hanaNode.url}/`);

  for (const page of [hanaPage, alicePage]) {
    await expect(page.getByRole('banner')).toContainText('auth-redesign');
    await expect(page.getByRole('banner')).toContainText('Connected');
    await expect(page.getByRole('complementary')).toContainText('Hana');
    await expect(page.getByRole('complementary')).toContainText('Alice');
  }

  await hanaPage.getByLabel('Message').fill("Let's review the auth design. I shared the spec.");
  await hanaPage.getByLabel('Message').press('Enter');
  await expect(
    alicePage.getByText("Let's review the auth design. I shared the spec."),
  ).toBeVisible();

  await alicePage.getByLabel('Message').fill('Possible race condition in token rotation.');
  await alicePage.getByLabel('Message').press('Enter');
  await expect(hanaPage.getByText('Possible race condition in token rotation.')).toBeVisible();
  await expect(hanaPage.getByLabel('Message')).toHaveValue('');

  await expect(hanaPage.getByRole('banner')).toContainText('2 online');

  // @ autocompletes people; the mention reaches Alice's inbox until she replies.
  await hanaPage.getByLabel('Message').fill('@Al');
  await expect(hanaPage.getByRole('list', { name: 'Mention someone' })).toContainText('@Alice');
  await hanaPage.getByLabel('Message').press('Enter');
  await expect(hanaPage.getByLabel('Message')).toHaveValue('@Alice ');
  await hanaPage.getByLabel('Message').pressSequentially('please check the spec');
  await hanaPage.getByLabel('Message').press('Enter');
  const aliceSidebar = alicePage.getByRole('complementary');
  await expect(aliceSidebar).toContainText('mentions you');
  await expect(alicePage.locator('span', { hasText: /^@Alice$/ }).first()).toBeVisible();
  await hanaPage.setViewportSize({ width: 1200, height: 720 });
  await hanaPage.screenshot({ path: 'test-results/chat-hana.png' });
  await alicePage.screenshot({ path: 'test-results/chat-alice.png' });
});

test('a page without the owner token is locked', async ({ page }) => {
  await page.goto(hanaNode.url);
  await expect(
    page.getByRole('heading', { name: 'Open Pearcoder from your terminal' }),
  ).toBeVisible();
});
