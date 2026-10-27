// The npm page shows packages/cli/README.md, not the repository README. It's generated from the
// root README with links made absolute (npm can't resolve repository-relative paths), so the two
// never drift: `node scripts/readme.mjs` rewrites it, and a test fails when it's stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/pearcoderhq/pearcoder';
const RAW = 'https://raw.githubusercontent.com/pearcoderhq/pearcoder/main';

export function npmReadme(root) {
  const relative = (path) => !/^(?:[a-z]+:|#|\/)/i.test(path);
  return root
    .replace(/src="([^"]+)"/g, (m, path) => (relative(path) ? `src="${RAW}/${path}"` : m))
    .replace(/href="([^"]+)"/g, (m, path) =>
      relative(path) ? `href="${REPO}/blob/main/${path}"` : m,
    )
    .replace(/\]\(([^)\s]+)\)/g, (m, path) =>
      relative(path) ? `](${REPO}/blob/main/${path})` : m,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
  writeFileSync(new URL('../README.md', import.meta.url), npmReadme(root));
}
