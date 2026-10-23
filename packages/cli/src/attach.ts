import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { claudeMarketplaceDir } from './paths.js';

const run = promisify(execFile);

export interface ClaudeCommand {
  args: string[];
  /** Failure is expected and fine (e.g. removing something that is not there). */
  optional?: boolean;
}

/** The plugin marketplace (`integrations/claude-code`, or its copy inside the npm package). */
export function marketplaceDir(): string {
  return claudeMarketplaceDir();
}

/**
 * What `pearcoder attach --agent claude` runs. It registers this Pearcoder as the `pearcoder` MCP
 * server for the user and installs the plugin with the restricted reviewer subagent. It never
 * changes Claude Code permissions: the owner approves Pearcoder's tools on first use.
 */
export function claudeAttachCommands(options: {
  home: string;
  defaultHome: boolean;
  binPath: string;
  nodePath: string;
  marketplace: string;
}): ClaudeCommand[] {
  return [
    { args: ['mcp', 'remove', 'pearcoder', '--scope', 'user'], optional: true },
    {
      args: [
        'mcp',
        'add',
        '--scope',
        'user',
        ...(options.defaultHome ? [] : ['-e', `PEARCODER_HOME=${options.home}`]),
        'pearcoder',
        '--',
        options.nodePath,
        options.binPath,
        'mcp',
      ],
    },
    {
      args: ['plugin', 'marketplace', 'add', options.marketplace, '--scope', 'user'],
      optional: true,
    },
    { args: ['plugin', 'marketplace', 'update', 'pearcoder'], optional: true },
    { args: ['plugin', 'install', 'pearcoder@pearcoder', '--scope', 'user'] },
  ];
}

export async function runClaude(
  args: string[],
  claudeBin = 'claude',
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await run(claudeBin, args, { timeout: 60_000 });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message };
  }
}

export function pluginShipped(): boolean {
  return existsSync(join(claudeMarketplaceDir(), '.claude-plugin', 'marketplace.json'));
}

export interface CodexAttachPlan {
  commands: ClaudeCommand[];
  /** Files Pearcoder owns and installs (overwritten on re-attach, nothing else is touched). */
  files: { from: string; to: string }[];
}

/**
 * What `pearcoder attach --agent codex` does: registers the MCP server and installs the
 * pearcoder-reviewer subagent and pearcoder-review skill. Codex has no tool allowlist for
 * subagents, so reviews should run with `--sandbox read-only` (integrations/codex/README.md).
 */
export function codexAttachPlan(options: {
  home: string;
  defaultHome: boolean;
  binPath: string;
  nodePath: string;
  codexHome: string;
  userHome: string;
  integration: string;
}): CodexAttachPlan {
  return {
    commands: [
      { args: ['mcp', 'remove', 'pearcoder'], optional: true },
      {
        args: [
          'mcp',
          'add',
          ...(options.defaultHome ? [] : ['--env', `PEARCODER_HOME=${options.home}`]),
          'pearcoder',
          '--',
          options.nodePath,
          options.binPath,
          'mcp',
        ],
      },
    ],
    files: [
      {
        from: join(options.integration, 'agents', 'pearcoder-reviewer.toml'),
        to: join(options.codexHome, 'agents', 'pearcoder-reviewer.toml'),
      },
      {
        from: join(options.integration, 'skills', 'pearcoder-review', 'SKILL.md'),
        to: join(options.userHome, '.agents', 'skills', 'pearcoder-review', 'SKILL.md'),
      },
      {
        from: join(options.integration, 'agents', 'pearcoder-discuss.toml'),
        to: join(options.codexHome, 'agents', 'pearcoder-discuss.toml'),
      },
      {
        from: join(options.integration, 'skills', 'pearcoder-discuss', 'SKILL.md'),
        to: join(options.userHome, '.agents', 'skills', 'pearcoder-discuss', 'SKILL.md'),
      },
      {
        from: join(options.integration, 'agents', 'pearcoder-listen.toml'),
        to: join(options.codexHome, 'agents', 'pearcoder-listen.toml'),
      },
      {
        from: join(options.integration, 'skills', 'pearcoder-listen', 'SKILL.md'),
        to: join(options.userHome, '.agents', 'skills', 'pearcoder-listen', 'SKILL.md'),
      },
    ],
  };
}
