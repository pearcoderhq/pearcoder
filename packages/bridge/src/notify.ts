import { spawn } from 'node:child_process';

/**
 * Best-effort desktop notification for the human (never for the agent session, docs/invariants.md, invariant 1).
 * Text goes through argv, never through a shell or script source, so it cannot inject commands.
 */
export function notify(title: string, message: string): void {
  // Control characters (newlines, escapes) are dropped; the text is shown, never interpreted.
  const short = (value: string) =>
    [...value]
      .map((c) => (c.charCodeAt(0) < 32 ? ' ' : c))
      .join('')
      .slice(0, 160);
  const [command, args] =
    process.platform === 'darwin'
      ? [
          'osascript',
          [
            '-e',
            'on run argv',
            '-e',
            'display notification (item 2 of argv) with title (item 1 of argv)',
            '-e',
            'end run',
            short(title),
            short(message),
          ],
        ]
      : process.platform === 'linux'
        ? ['notify-send', ['--app-name=Pearcoder', short(title), short(message)]]
        : [undefined, []];
  if (!command) return;
  try {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Notifications are optional.
  }
}
