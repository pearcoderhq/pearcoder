import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs build script without type declarations
import { npmReadme } from '../scripts/readme.mjs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('npm README', () => {
  // 0.7.0 shipped a README that still said "early release (0.1)": the npm page reads this file,
  // not the repository README.
  it('is generated from the repository README (run `node packages/cli/scripts/readme.mjs`)', () => {
    expect(read('../README.md')).toBe(
      (npmReadme as (root: string) => string)(read('../../../README.md')),
    );
  });

  it('has no repository-relative links', () => {
    const out = (npmReadme as (root: string) => string)(
      '<img src="assets/a.png"> [x](docs/q.md) [y](#top) [z](https://e.com) <a href="assets/v.mp4">',
    );
    expect(out).toContain(
      'src="https://raw.githubusercontent.com/pearcoderhq/pearcoder/main/assets/a.png"',
    );
    expect(out).toContain('](https://github.com/pearcoderhq/pearcoder/blob/main/docs/q.md)');
    expect(out).toContain('[y](#top)');
    expect(out).toContain('[z](https://e.com)');
    expect(out).toContain('href="https://github.com/pearcoderhq/pearcoder/blob/main/assets/v.mp4"');
  });
});
