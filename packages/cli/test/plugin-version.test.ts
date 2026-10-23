import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version: string };

describe('Claude Code plugin', () => {
  // Claude Code caches plugins by version: an unchanged version keeps the old subagents installed
  // after `pearcoder attach` (0.3.0–0.4.1 shipped 0.1.0 and missed /pearcoder:listen).
  it('carries the CLI version', () => {
    expect(
      read('../../../integrations/claude-code/plugins/pearcoder/.claude-plugin/plugin.json')
        .version,
    ).toBe(read('../package.json').version);
  });
});
