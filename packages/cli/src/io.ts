import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything a command touches outside itself, so tests can run commands in-process. */
export interface Io {
  stdout(line: string): void;
  stderr(line: string): void;
  env: Record<string, string | undefined>;
  /** Long-running commands (host, watch) stop when this aborts. */
  signal: AbortSignal;
  isTTY: boolean;
}

/** Wrong arguments or missing setup: exit code 2, message only. */
export class UsageError extends Error {
  override name = 'UsageError';
}

export function homeOf(io: Io): string {
  return io.env.PEARCODER_HOME ?? join(homedir(), '.pearcoder');
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}
