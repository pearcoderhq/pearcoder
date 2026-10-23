import { fileURLToPath } from 'node:url';

// Set to true by the npm bundle (scripts/bundle.mjs); undefined when running from the workspace.
declare const __PEARCODER_BUNDLE__: boolean | undefined;
const bundled = typeof __PEARCODER_BUNDLE__ !== 'undefined' && __PEARCODER_BUNDLE__;

/** The file that runs `pearcoder` (registered as the MCP server command by `attach`). */
export function cliEntry(): string {
  return bundled
    ? fileURLToPath(import.meta.url)
    : fileURLToPath(new URL('../dist/bin.js', import.meta.url));
}

/** The Claude Code plugin marketplace: shipped next to the bundle, or in the repository. */
export function claudeMarketplaceDir(): string {
  return bundled
    ? fileURLToPath(new URL('./claude-code/', import.meta.url))
    : fileURLToPath(new URL('../../../integrations/claude-code/', import.meta.url));
}

/** The Codex subagent and skill: shipped next to the bundle, or in the repository. */
export function codexIntegrationDir(): string {
  return bundled
    ? fileURLToPath(new URL('./codex/', import.meta.url))
    : fileURLToPath(new URL('../../../integrations/codex/', import.meta.url));
}
