# Pearcoder

*Where agents and humans have a tea party.*

Collaboration sessions for developers and their AI coding agents.

Pearcoder is a local-first collaboration layer for developers and their AI coding agents. Each developer keeps using their own agent (Claude Code first, Codex next) with their own subscription. Pearcoder gives the team a shared session for discussion, review requests, findings, and decisions, and gives each agent read access plus a private drafts folder through MCP.

**Nobody can run your agent but you, and that includes Pearcoder.** Colleagues can ask, discuss, and share. Your agent only touches Pearcoder when you ask it to, and nothing it writes leaves your machine until you approve it.

> Status: early release (0.1). Feedback welcome on [X](https://x.com/pearcoder) or [LinkedIn](https://www.linkedin.com/company/pearcoder).

## Get started in 5 minutes

You need [Node.js](https://nodejs.org) 22.13 or newer (check with `node --version`). Every person installs Pearcoder on their own machine:

```bash
npm install -g pearcoder
pearcoder whoami --set-name "Your Name"
```

### 1. Start a session (one person)

```bash
pearcoder host --name auth-review --lan
```

This prints an invitation (`pc1_…`) and opens the web UI. Send the invitation privately (Slack DM, for example). It works once and expires in 24 hours. Leave the command running: the session lasts until you press Ctrl-C.

Teammates must be on the same network, or the same Tailscale or WireGuard network. To try it alone on one machine, leave out `--lan`.

### 2. Join (everyone else)

```bash
pearcoder join pc1_…
pearcoder ui
```

`pearcoder ui` opens the session in your browser. Chat, review requests, findings and decisions all happen there. Type `@` to mention someone or someone's agent (`@Alice's Claude Code`): it lands in their inbox. Everything also works from the terminal: `pearcoder say "@Alice hi"`, `pearcoder watch`.

### 3. Let your own agent help review (optional)

Run this once to connect your Claude Code (or `--agent codex` for Codex):

```bash
pearcoder attach --agent claude
```

Then the review loop:

1. **Ask for a review.** In the UI, use "Ask someone for a review" and pick a person, or their agent ("Alice's Claude Code"). You can pick your own agent too. From the terminal:

   ```bash
   pearcoder share --pr 42                                  # or: pearcoder share spec.md --objective "Find races"
   pearcoder request --to Alice --package latest "Review the token rotation"
   pearcoder request --to Alice --for-agent claude "Review the token rotation"   # address her Claude Code
   ```

2. **Review with your agent.** Alice sees the request in her inbox (web UI or `pearcoder inbox`), opens Claude Code in the repository and types `/pearcoder:review`. With no id it takes her oldest open request. Her agent reads the request and the code and saves its findings as **private drafts**. It can't run commands, edit files or post anything.
3. **Publish.** Alice checks the drafts in the UI's Drafts panel (or with `pearcoder drafts`), edits them, and publishes the ones she agrees with.
4. **Decide and keep the result:**

   ```bash
   pearcoder findings                       # what was found, and what is still open
   pearcoder resolve <id> fixed             # short ids from the listings work
   pearcoder export --out review.md         # the consolidated review: findings, decisions, action items
   pearcoder github-review 42               # preview the findings as one GitHub PR review; add --post to post it
   ```

Want your agent to keep up on its own? Run `/pearcoder:listen` in Claude Code. While it runs, it drafts a finding for each new review request and an answer for each `@` mention of your agent. With **auto** on (the default; a banner in the UI says so), Pearcoder sends its replies after a secret scan. Turn auto off per session in the UI or with `pearcoder agent auto off`: then you let your agent handle each item, and each reply waits for your Send. `/pearcoder:listen once` handles what's waiting and stops. Without the listener, answer a mention yourself with `/pearcoder:discuss <id>` (your agent drafts it) or `pearcoder say --reply <id> "…"`.

Nobody's agent ever starts because someone else asked. Requests and mentions only show up in people's inboxes.

### Handy to know

- `pearcoder --help` lists every command. Every command takes `--json`.
- `pearcoder host --name auth-review --persist` keeps the session across restarts. Continue it later with `pearcoder host --resume auth-review`.
- `pearcoder doctor` checks your setup. `pearcoder status` lists your sessions; `pearcoder forget <name>` removes one that ended.
- **Upgrading:** `npm install -g pearcoder`, then `pearcoder attach --agent claude` again so Claude Code gets new commands.
- Your device key stays in `~/.pearcoder/` and never leaves your machine. Keep the web UI link private: it lets the browser act as you.
