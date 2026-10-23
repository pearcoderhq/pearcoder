import { createRequire } from 'node:module';
import { DraftError } from '@pearcoderhq/bridge';
import { PearcoderError } from '@pearcoderhq/core';
import { InvitationFormatError } from '@pearcoderhq/protocol';
import * as commands from './commands.js';
import { type Io, UsageError } from './io.js';

export const HELP = `pearcoder: where agents and humans have a tea party

Usage: pearcoder <command> [options]

Sessions
  host --name <name> [--persist] [--lan] [--port N] [--tls-cert F --tls-key F] [--as <you>]
       [--role member|observer] [--no-ui] [--no-open] [--notify]
                       host a session (local only unless --lan; runs until Ctrl-C);
                       --role sets the first invitation, --notify shows desktop notifications
  host --resume <name|id>
                       host a --persist session again with its history and invitations
  join <invitation> [--as <you>]
                       join a session you were invited to
  invite [--role member|observer] [--expires 24h] [--uses 1]
                       create another invitation (host only)
  say <text> [--reply <id>]
                       post a message; @Name mentions someone, @Name's Claude Code their agent
  watch                follow a session live
  status               list your sessions (and whether each host is reachable)
  forget <name|id>     forget an ended session on this device
  ui [--port N] [--no-open] [--notify]
                       open the web UI for all your sessions (host opens it too;
                       use host --no-ui or --no-open to skip)

Review
  share [spec.md] --objective "…" [--path P] [--excerpt P:10-40] [--constraint C] [--base main]
                       publish a context package (scanned for secrets; --redact, --dry-run)
  share --pr <number|url> [--objective "…"]
                       publish a GitHub PR (description, files, base/head SHAs, diff) via gh
  request --to <name> [--to <name>…] [--kind review] [--package <id|latest>] [--body "…"] [--for-agent claude|codex] "<title>"
                       ask people to look at something (never starts anyone's agent)
  inbox [--all]        requests addressed to you
  resolve <id> <outcome> [--note …]
                       requests: accepted|declined|done · findings: fixed|accepted_risk|wont_fix|invalid
                       decisions: accepted|rejected|superseded (proposer or host)
  decide "<title>" --decision "…" [--rationale …] [--alternative …] [--related <id>]
  vote <decision-id> agree|disagree|abstain [--note …]
  findings [--all]     open findings with severity, author and status (--all: resolved too)
  decisions            decisions with their stances and outcomes
  export [--format md|jsonl] [--out FILE]
                       the session's outcome as a review document, or the signed log
  verify <export.jsonl> check signatures and the host seal of an exported log
  github-review <pr> [--include-resolved] [--post]
                       turn the findings about a PR into one GitHub review (preview unless --post)
  drafts [<id>] [--all]  your agent's private drafts
  publish <draft-id> [--redact | --allow-secrets]
                       share a draft with the session (scanned for secrets first)
  discard <draft-id>   drop a draft without sharing it

Building together
  task "<title>" [--body "…"] [--to <name>|me [--agent claude|codex]]
                       create a task; assigning someone's agent asks its owner first
  task <id> [--status open|in_progress|blocked|done] [--to …] [--note "…"]
                       update a task (its creator, assignee or the host)
  tasks [--all]        open tasks and who has them

Agents
  attach --agent claude|codex [--dry-run]
                       add Pearcoder to your agent: MCP server + restricted reviewer
  agent [auto mine|others on|off] [allow <id> [--text "…"]] [decline <id>] [stop <id>]
        [status on|off] [--session <name|id>]
                       how your agent acts: your own messages go straight to it (mine, default
                       on); other people's wait for you to approve or edit them (others, default
                       off); status shares waiting/working/done, never content
  doctor               check identity, sessions, and the Claude Code setup
  mcp                  MCP server for your own Claude Code (started by Claude Code)

You
  whoami [--set-name <name>]
                       show or set your name and device identity

Options
  --session <name|id>  pick a session when you are in several
  --json               machine-readable output
  -h, --help           show this help
  -v, --version        print the version
`;

// src/, dist/ and the npm bundle all sit one level below the package's package.json.
const VERSION: string = createRequire(import.meta.url)('../package.json').version;

type Command = (argv: string[], io: Io) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  host: commands.host,
  join: commands.join,
  invite: commands.invite,
  say: commands.say,
  watch: commands.watch,
  status: commands.status,
  forget: commands.forget,
  ui: commands.ui,
  share: commands.share,
  request: commands.request,
  inbox: commands.inbox,
  resolve: commands.resolve,
  decide: commands.decide,
  vote: commands.vote,
  findings: commands.findings,
  decisions: commands.decisions,
  export: commands.exportSession,
  'github-review': commands.githubReview,
  verify: commands.verify,
  drafts: commands.drafts,
  publish: commands.publish,
  discard: commands.discard,
  mcp: commands.mcp,
  attach: commands.attach,
  agent: commands.agent,
  task: commands.task,
  tasks: commands.tasks,
  doctor: commands.doctor,
  whoami: commands.whoami,
};

/** Runs one CLI invocation. Exit codes: 0 ok, 1 failure, 2 usage error. */
export async function main(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === '-h' || name === '--help' || name === 'help') {
    io.stdout(HELP);
    return name ? 0 : 2;
  }
  if (name === '--version' || name === '-v' || name === 'version') {
    io.stdout(VERSION);
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.stderr(`unknown command: ${name}\n\n${HELP}`);
    return 2;
  }
  if (rest.includes('-h') || rest.includes('--help')) {
    io.stdout(HELP);
    return 0;
  }
  try {
    return await command(rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`error: ${error.message}`);
      return 2;
    }
    if (
      error instanceof PearcoderError ||
      error instanceof InvitationFormatError ||
      error instanceof DraftError
    ) {
      io.stderr(`error: ${error.message} (${error.code})`);
      return 1;
    }
    io.stderr(`error: ${(error as Error).message ?? String(error)}`);
    return 1;
  }
}
