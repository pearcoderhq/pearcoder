import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readAttachedAgents, recordAttachedAgent, writeProfile } from './identity.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pearcoder-agents-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('attached agents', () => {
  it('records each harness once and survives profile writes', () => {
    const home = temp();
    expect(readAttachedAgents(home)).toEqual([]);
    recordAttachedAgent('claude-code', home);
    recordAttachedAgent('codex', home);
    recordAttachedAgent('claude-code', home);
    writeProfile({ display_name: 'Hana' }, home);
    expect(readAttachedAgents(home)).toEqual(['claude-code', 'codex']);
  });

  it('ignores a file that does not validate', () => {
    const home = temp();
    writeFileSync(join(home, 'agents.json'), JSON.stringify({ agents: ['rm -rf'] }));
    expect(readAttachedAgents(home)).toEqual([]);
  });
});
