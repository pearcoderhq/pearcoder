<p align="center">
  <img src="assets/brand/pearcoder_logo_with_text.png" alt="Pearcoder" width="320">
</p>

<p align="center"><em>Where agents and humans have a tea party.</em></p>

<p align="center"><a href="https://www.npmjs.com/package/pearcoder"><img src="https://img.shields.io/npm/v/pearcoder" alt="npm version"></a></p>

<p align="center">
  <img src="assets/demo/pearcoder-demo.gif" alt="Hana gives a task to Alice's Claude Code. Alice rewrites and approves it, her own Claude Code changes the code and pushes a branch, and Hana sees the commit." width="900">
</p>

<p align="center"><sub>Real UI, real Claude Code run (<code>/pearcoder:dev</code>). <a href="assets/demo/pearcoder-demo.mp4">MP4</a> · recorded with <code>e2e/demo/record.mjs</code></sub></p>

Collaboration sessions for developers and their AI coding agents. Pearcoder is local-first: each developer keeps using their own agent (Claude Code or Codex) with their own subscription. The team gets a shared session for discussion, review requests, findings, decisions, tasks and pushed branches. Each agent reads it, and writes into it, only through MCP.

**Nobody can run your agent but you, and that includes Pearcoder.** Colleagues can ask, discuss, and share. Your agent only touches Pearcoder when you ask it to, and nothing it writes leaves your machine until you approve it.

**Let teammates ask for changes without handing over your keyboard or your Claude login.** A teammate's request lands in your inbox. You approve it or rewrite it in your own words, and your own agent does the work on your machine, with your subscription. Nobody shares an account, and nobody else drives your agent.

> Status: early release (0.6). Feedback welcome on [X](https://x.com/pearcoder) or [LinkedIn](https://www.linkedin.com/company/pearcoder).

## Get started in 5 minutes

You need [Node.js](https://nodejs.org) 22.13 or newer (check with `node --version`). Every person installs Pearcoder on their own machine and connects their own agent:

```bash
npm install -g pearcoder
pearcoder whoami --set-name "Your Name"
pearcoder attach --agent claude          # or --agent codex
```

### 1. Start or join a session

One person hosts:

```bash
pearcoder host --name auth-review --lan
```

This prints an invitation (`pc1_…`) and opens the web UI. Send the invitation privately (Slack DM, for example). It works once and expires in 24 hours. Leave the command running: the session lasts until you press Ctrl-C. Teammates must be on the same network, or the same Tailscale or WireGuard network. To try it alone on one machine, leave out `--lan`.

Everyone else joins:

```bash
pearcoder join pc1_…
pearcoder ui
```

`pearcoder ui` opens the session in your browser. Type `@` to mention someone or someone's agent (`@Alice's Claude Code`): it lands in their inbox.

### 2. Let your agent listen and build

Open Claude Code in your repository and run:

```text
/pearcoder:listen     # your agent drafts findings for review requests and answers for @mentions of it
/pearcoder:dev        # your agent works on your own items and pushes a branch
```

**Listen mode** keeps watch while it runs. For each new review request it drafts a finding, and for each `@` mention of your agent it drafts an answer. A mention can ask for work: `@Hana's Claude Code which PRs wait for my review?`, `… review PR 42`, `… the changes in feat/retry against main`, or `… src/token.ts`. `/pearcoder:listen once` handles what's waiting and stops.

**Dev mode** works on your own items: what you @mention your agent with, tasks you gave it (`pearcoder task "Retry on 503" --to me --agent claude`), or someone's item you rewrote and approved. It edits the repository and pushes a branch through `git_commit_push`. That tool never pushes `main`, `master`, the default branch or branches you protect. It never forces, runs with git hooks off, and refuses secrets and oversized changes. The session then sees "your agent pushed `pearcoder/retry` @ `abc1234`". Code itself never goes through Pearcoder: people fetch and review the commit with git, as with any colleague's branch.

With Codex, ask it to use the `pearcoder-listen` or `pearcoder-dev` skill (run dev mode with `codex --sandbox workspace-write`). See [integrations/codex](integrations/codex/README.md).

Nobody's agent ever starts because someone else asked. Requests and mentions only show up in people's inboxes, and other people's items wait for your approval (see [auto modes](#auto-modes)).

## More commands

### Talk

Chat, review requests, findings and decisions all happen in the web UI. Everything also works from the terminal: `pearcoder say "@Alice hi"`, `pearcoder watch`, `pearcoder inbox`. Answer a mention yourself with `/pearcoder:discuss <id>` (your agent drafts it) or `pearcoder say --reply <id> "…"`.

An agent only sees a message that mentions it. If you type a request for work without mentioning anyone, the UI points this out and offers to mention your own agent in one click.

### Review

1. **Ask for a review.** In the UI, use "Ask someone for a review" and pick a person, or their agent ("Alice's Claude Code"). You can pick your own agent too. From the terminal:

   ```bash
   pearcoder share --pr 42                                  # or: pearcoder share spec.md --objective "Find races"
   pearcoder request --to Alice --package latest "Review the token rotation"
   pearcoder request --to Alice --for-agent claude "Review the token rotation"   # address her Claude Code
   ```

2. **Review with your agent.** Alice sees the request in her inbox (web UI or `pearcoder inbox`), opens Claude Code in the repository and types `/pearcoder:review` (or lets `/pearcoder:listen` pick it up). With no id it takes her oldest open request. Her agent reads the request and the code and saves its findings as **private drafts**. It can't run commands, edit files or post anything.
3. **Publish.** Alice checks the drafts in the UI's Drafts panel (or with `pearcoder drafts`), edits them, and publishes the ones she agrees with (`pearcoder publish <draft-id>`).
4. **Decide and keep the result:**

   ```bash
   pearcoder findings                       # what was found, and what is still open
   pearcoder resolve <id> fixed             # short ids from the listings work
   pearcoder decide "Rotate tokens hourly" --decision "…"
   pearcoder export --out review.md         # the consolidated review: findings, decisions, action items
   pearcoder github-review 42               # preview the findings as one GitHub PR review; add --post to post it
   ```

### Tasks

Tasks say who does what: `pearcoder task "Retry on 503" --to Hana`, or `--to me --agent claude` to give it to your own agent (also in the UI: "Create a task"). `pearcoder tasks` lists open tasks and who has them. Everyone sees what each agent is doing (waiting for its owner, working, done), never what it reads or writes. `pearcoder agent stop <id>` (or Stop in the UI) ends a run's work on an item.

### Auto modes

Your agent has two auto modes per session (the UI's agent bar, or `pearcoder agent auto mine|others on|off`):

- **Mine**, on by default: your own messages and tasks go straight to your agent, and Pearcoder sends its answers after a secret scan.
- **Others**, off by default: other people's mentions, requests and tasks wait for you. Approve one (`pearcoder agent allow <id>`), decline it (`pearcoder agent decline <id>`), or rewrite it and approve your version (`pearcoder agent allow <id> --text "…"`). Your agent reads your version, and the session only sees "approved with edits". Turning it on lets anyone in the session make your agent answer unseen; the banner says so.

`pearcoder agent status off` stops sharing your agent's activity.

### Handy to know

- `pearcoder --help` lists every command. Every command takes `--json`.
- `pearcoder host --name auth-review --persist` keeps the session across restarts. Continue it later with `pearcoder host --resume auth-review`.
- `pearcoder invite` creates another invitation (host only).
- `pearcoder doctor` checks your setup. `pearcoder status` lists your sessions; `pearcoder forget <name>` removes one that ended.
- **Upgrading:** `npm install -g pearcoder`, then `pearcoder attach --agent claude` again so Claude Code gets new commands.
- Your device key stays in `~/.pearcoder/` and never leaves your machine. Keep the web UI link private: it lets the browser act as you.
- Full walkthrough: [docs/quickstart.md](docs/quickstart.md). Security model: [docs/threat-model.md](docs/threat-model.md).

## How is this different from…

- **Workspaces where agents are teammates** (for example Block's [Buzz](https://buzz.xyz)): those put agents into team channels as coworkers, next to chat and code hosting. Pearcoder takes the other approach: an agent is a tool of one person. It works only when its owner starts it, other people's requests wait for the owner's approval, and everything it writes stays a private draft until the owner shares it. Pearcoder also doesn't replace your chat or your Git host: code stays on GitHub (or wherever you push), and the session holds the review, the discussion and the decisions.
- **Pasting agent output into Slack or PR comments**: each person's agent reviews against their own checkout and drafts findings in a shared, structured session, where they can be discussed and end in a decision you can export.

## Run from source

```bash
pnpm install && pnpm build
alias pearcoder="node $PWD/packages/cli/dist/pearcoder.mjs"   # the same bundle npm ships
```

## Repository layout

| Package | License | Purpose |
|---------|---------|---------|
| `packages/protocol` | Apache-2.0 | Event envelope, event types, schemas |
| `packages/core` | FSL-1.1-ALv2 | Session engine |
| `packages/server` | FSL-1.1-ALv2 | HTTP and WebSocket session server, LAN TLS |
| `packages/client` | FSL-1.1-ALv2 | Connection to a session host: join, login, live stream, reconnect |
| `packages/bridge` | FSL-1.1-ALv2 | Local node: owner-only API and web UI; later inbox, drafts, approvals |
| `packages/mcp` | FSL-1.1-ALv2 | Pull-only MCP server for your own agent |
| `packages/cli` | FSL-1.1-ALv2 | The `pearcoder` command |
| `packages/web` | FSL-1.1-ALv2 | Web UI |

See [LICENSE.md](LICENSE.md) for what each license allows.

## Development

Requires Node 24 (`nvm use`) and pnpm 12.

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm build
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/invariants.md](docs/invariants.md) before contributing; they apply to humans and coding agents alike. Security issues: see [SECURITY.md](SECURITY.md).

## Links

- X: https://x.com/pearcoder
- LinkedIn: https://www.linkedin.com/company/pearcoder
- npm: https://www.npmjs.com/package/pearcoder
