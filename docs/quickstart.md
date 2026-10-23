# Quickstart: a LAN session in five minutes

Pearcoder is pre-alpha and runs from source for now.

## 1. Install (each person)

Needs Node.js 22.13 or newer.

```bash
npm install -g pearcoder
pearcoder whoami --set-name "Your Name"
```

Install it globally rather than running it through `npx`: `pearcoder attach` points your agent at the installed file, and npx's cache can be cleared.

The first command that needs it creates your device key in `~/.pearcoder/identity/`. It never leaves your machine. Set `PEARCODER_HOME` to use another folder, for example to try two people on one machine.

## 2. Host (one person)

```bash
pearcoder host --name auth-review --lan
```

- Pearcoder listens on your LAN with TLS. On first use it generates a certificate in `~/.pearcoder/tls/`. To use your own instead, pass `--tls-cert cert.pem --tls-key key.pem`.
- macOS asks once whether `node` may accept incoming connections. Allow it.
- The terminal prints a single-use invitation (`pc1_…`) and opens the web UI. Send the invitation privately, for example in a DM. It contains your certificate's fingerprint, so joiners connect only to you.
- More invitations: `pearcoder invite` (`--role observer`, `--uses 5`, `--expires 2h`).
- Hosting lasts until you press Ctrl-C. Add `--persist` to keep the session (history, members, invitations) in `~/.pearcoder/hosted/`, and continue later with `pearcoder host --resume auth-review`. Without it, stopping ends the session.

## 3. Join (everyone else)

```bash
pearcoder join pc1_… 
pearcoder ui          # opens the web UI with your sessions
```

From the terminal instead: `pearcoder say "…"` and `pearcoder watch`.

## 4. Review with your own Claude Code

```bash
pearcoder attach --agent claude
```

This command:
- registers `pearcoder` as an MCP server for your user, which reads sessions and saves private drafts;
- installs the Pearcoder plugin, with `/pearcoder:review` and the restricted `pearcoder-reviewer` subagent.

Using Codex? Run `pearcoder attach --agent codex`. It installs the same reviewer as a Codex subagent and skill. Review with `codex --sandbox read-only`, because Codex can't restrict a subagent's tools the way Claude Code does.

Restart Claude Code. The first time the reviewer uses a Pearcoder tool, choose "always allow" for the Pearcoder tools. Check the setup any time with `pearcoder doctor`.

The flow:

1. **Requester:** `pearcoder share spec.md --objective "…" --path src/x.ts` publishes a context package (scanned for secrets), then `pearcoder request --to Alice --package latest "…"` asks for the review. You can also use "Ask someone for a review" in the web UI.
2. **Reviewer:** the request shows up in `pearcoder inbox` and the UI's inbox. Click "Copy review prompt", or run `/pearcoder:review <id>` in Claude Code inside the repository.
3. The reviewer subagent reads the request and the code and saves findings as **private drafts**. It can't run commands, edit files, use the web, or publish.
4. To answer findings or objections about your own code, run `/pearcoder:discuss`. The discuss subagent drafts replies the same way, and they stay private until you post them.
5. **Reviewer:** check the drafts in the UI's Drafts panel or with `pearcoder drafts`, edit them, and publish. Pearcoder scans for secrets first and blocks until you redact.

6. **Requester:** for a GitHub PR shared with `pearcoder share --pr <n>`, `pearcoder github-review <n>` previews the findings as one GitHub review: inline comments on lines in the diff, the rest in the review body. Add `--post` to post it. Pearcoder never posts on its own.

Nothing happens on anyone's machine because someone else asked. Requests only notify people; add `--notify` to `pearcoder ui` for desktop notifications.

## Across the internet

Use a private network both sides trust, such as Tailscale or WireGuard. Host with `--lan` on the overlay. Tailscale users can give Pearcoder the machine's certificate from `tailscale cert`. Never expose the host port publicly.

## What's private

- **Never sent:** your device key and the web UI link. The UI link is printed by `pearcoder ui` and `host`; keep it private, because it lets the browser act as you.
- **Shared with session participants:** what you post.
- **On the wire:** everything is signed by its author, so the host can order messages but can't forge them.
