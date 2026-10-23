// Packs the npm package, installs the tarball into an empty directory, and exercises the real
// binary: help, identity, hosting, joining over the network, and serving the web UI.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'pearcoder-pack-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const sh = { shell: process.platform === 'win32' };
try {
  const tarball = execFileSync(pnpm, ['pack', '--pack-destination', work], {
    cwd: cli,
    encoding: 'utf8',
    ...sh,
  })
    .trim()
    .split('\n')
    .at(-1);
  execFileSync(npm, ['init', '-y'], { cwd: work, stdio: 'ignore', ...sh });
  execFileSync(npm, ['install', '--no-audit', '--no-fund', tarball], {
    cwd: work,
    stdio: 'inherit',
    ...sh,
  });
  const bin = join(work, 'node_modules', 'pearcoder', 'dist', 'pearcoder.mjs');
  const run = (home, args) =>
    execFileSync(process.execPath, [bin, ...args], {
      env: { ...process.env, PEARCODER_HOME: home },
      encoding: 'utf8',
    });

  if (!run(work, ['--help']).includes('Usage: pearcoder')) throw new Error('help missing');
  const hana = join(work, 'hana');
  const alice = join(work, 'alice');
  run(hana, ['whoami', '--set-name', 'Hana']);
  run(alice, ['whoami', '--set-name', 'Alice']);

  const host = spawn(process.execPath, [bin, 'host', '--name', 'smoke', '--port', '0', '--json'], {
    env: { ...process.env, PEARCODER_HOME: hana },
  });
  const hosting = await new Promise((resolve, reject) => {
    let buffer = '';
    host.stdout.on('data', (d) => {
      buffer += d;
      const line = buffer.split('\n').find((l) => l.includes('"hosting"'));
      if (line) resolve(JSON.parse(line));
    });
    host.on('exit', (code) => reject(new Error(`host exited ${code}`)));
    setTimeout(() => reject(new Error('host did not start')), 20_000);
  });
  run(alice, ['join', hosting.invite]);
  run(alice, ['say', 'hello from the npm package']);
  const ui = await fetch(hosting.ui_url.split('#')[0]);
  const html = await ui.text();
  if (!ui.ok || !html.includes('<div id="root">'))
    throw new Error('web UI not served from the package');
  const attach = run(alice, ['attach', '--agent', 'claude', '--dry-run']);
  if (!attach.includes(join('node_modules', 'pearcoder', 'dist', 'claude-code')))
    throw new Error(`plugin path wrong:\n${attach}`);
  host.kill('SIGINT');
  console.log('npm package smoke test passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
