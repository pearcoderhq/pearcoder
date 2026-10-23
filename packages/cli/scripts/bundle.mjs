// Builds the npm package: one ESM file with every @pearcoderhq/* package and dependency inlined,
// plus the web UI and the Claude Code plugin next to it (ADR-0002: npm bundles internal packages).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const cli = fileURLToPath(new URL('..', import.meta.url));
const repo = fileURLToPath(new URL('../../..', import.meta.url));
const out = `${cli}dist/`;
const web = `${repo}packages/web/dist/app/`;
if (!existsSync(`${web}index.html`))
  throw new Error('build the web UI first (pnpm --filter @pearcoderhq/web build)');

await build({
  entryPoints: [`${cli}src/bin.ts`],
  outfile: `${out}pearcoder.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: false,
  sourcemap: 'linked',
  legalComments: 'linked',
  // Bundle workspace packages from their TypeScript sources.
  conditions: ['@pearcoderhq/source'],
  define: { __PEARCODER_BUNDLE__: 'true' },
  // Optional native accelerators of `ws`; it works without them.
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire as __pcCreateRequire } from 'node:module'; const require = __pcCreateRequire(import.meta.url);",
  },
  plugins: [
    {
      // The web UI is served from the copy next to the bundle, not from the workspace.
      name: 'pearcoder-web-assets',
      setup(b) {
        b.onResolve({ filter: /^@pearcoderhq\/web$/ }, () => ({
          path: 'web-assets',
          namespace: 'pearcoder',
        }));
        b.onLoad({ filter: /.*/, namespace: 'pearcoder' }, () => ({
          contents:
            "import { fileURLToPath } from 'node:url'; export const webAssetsDir = fileURLToPath(new URL('./web/', import.meta.url));",
          loader: 'js',
        }));
      },
    },
  ],
  logLevel: 'warning',
});

for (const dir of ['web', 'claude-code', 'codex'])
  rmSync(`${out}${dir}`, { recursive: true, force: true });
cpSync(web, `${out}web`, { recursive: true });
cpSync(`${repo}integrations/claude-code`, `${out}claude-code`, { recursive: true });
cpSync(`${repo}integrations/codex`, `${out}codex`, { recursive: true });
console.log('bundled dist/pearcoder.mjs with web UI and Claude Code plugin');
