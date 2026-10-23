#!/usr/bin/env node
import { main } from './main.js';

// Unflagged node:sqlite arrived in Node 22.13; older versions fail with a confusing error later.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(
    `pearcoder needs Node.js 22.13 or newer; this is ${process.version}. Upgrade, e.g. \`nvm install 24\`.\n`,
  );
  process.exit(1);
}

// node:sqlite is still flagged experimental; that note is for Node developers, not our users.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const controller = new AbortController();
let interrupts = 0;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    interrupts += 1;
    // First Ctrl-C stops gracefully; a second one exits immediately.
    if (interrupts > 1) process.exit(130);
    controller.abort();
  });
}

const code = await main(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  signal: controller.signal,
  isTTY: Boolean(process.stdout.isTTY),
});

// Keep-alive connections to the host would hold the process open; exit once output is flushed.
process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
