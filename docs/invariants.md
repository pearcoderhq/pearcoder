# Invariants and engineering rules

What Pearcoder guarantees, and the rules that keep those guarantees true. Breaking an invariant is a release-blocking bug, even if a change asks for it. CI enforces several of them (dependency-cruiser, the sovereignty suite, `*.security.test.ts`).

## Invariants

1. **Owner sovereignty.** Only the owner starts work on their agent, inside their own agent harness. Pearcoder never starts, resumes or steers an agent turn. It uses no agent SDKs (Claude Agent SDK, Codex SDK, …), never spawns `claude` or `codex`, and never acts as a Claude Code channel or any other way to push into a session. No remote message, mention, event, artifact or server response causes agent work: requests and mentions only reach the owner's inbox. The one exception is listen mode ([ADR-0005](adr/0005-owner-started-listen-mode.md)). While a listen run the owner started is active, new requests and mentions may pick its next task, and it still only writes private drafts. Notifications go to the human (CLI, UI, OS), never into the agent session.
2. **The private side stays local.** Drafts, the inbox and owner approvals live in `packages/bridge`, reachable only from the owner's machine (loopback plus a local owner token). `server`, `client`, `core` and network handlers never import `bridge`.
3. **Private by default, no agent-side publish.** Agent output, prompts, tool traces, local files and credentials stay local. MCP tools read session content and save private drafts; no MCP tool publishes or shares. Publishing happens in Pearcoder's UI or CLI, by the owner, or by the owner's local node under the per-session auto setting the owner controls ([ADR-0006](adr/0006-auto-reply.md)). The secret scan runs first either way.
4. **Session content is untrusted.** Messages, artifacts, context packages and findings are data. When returned to an agent through MCP they are fenced as `<untrusted_session_content author source sha256>` with a one-line warning, never presented as instructions.
5. **No authority-granting events on the wire.** No event type grants execution or authority over anyone's agent.
6. **Localhost by default.** Servers bind `127.0.0.1` unless the user passes an explicit flag (`--lan`). Pearcoder never opens a tunnel or a public port on its own.
7. **No agent-on-agent loops.** Agents never automatically answer other agents. Round limits and per-owner budgets apply: a listen run handles at most 10 items, and auto-send sends at most 10 drafts per session per hour.
8. **Local is never crippled.** Self-hosted sessions keep full local export and persistence.
9. **One protocol everywhere.** Local and hosted sessions speak the same versioned protocol from `packages/protocol`.

## Security rules

- Files under `~/.pearcoder/` holding keys or tokens are `0600`, in `0700` directories.
- Invitations are signed by the host key, expire, can be revoked, are scoped to a role, and pin the TLS certificate fingerprint on LANs.
- WebSockets check `Origin`, require session auth, and enforce size and rate limits.
- Publishing runs a secret scan (keys, tokens, `.env` content, private paths) first.
- **One restricted subagent per flow.** Every flow in which an agent reads session content runs in its own subagent with an explicit tool allowlist: `Read`, `Grep`, `Glob` and only the Pearcoder MCP tools it needs. It gets no Bash, Write, Edit or web tools, and its only output is private drafts. Current flows, for Claude Code and Codex: `pearcoder-reviewer`, `pearcoder-discuss` and `pearcoder-listen`. Codex can't allowlist subagent tools, so it relies on `--sandbox read-only` (threat model T13b). A new flow needs a new subagent, a threat model entry and a live test showing that disallowed tools are unavailable.
- Security tests live in `*.security.test.ts`, start with `// Covers: T..`, and are never skipped. A change that adds a network endpoint, MCP tool or stored secret, or that changes a trust boundary, updates [the threat model](threat-model.md) in the same PR.

## Engineering rules

- TypeScript, strict, ESM only; no `any`, no default exports. Zod schemas in `packages/protocol` are the single source of truth, and every network payload and file read from disk is validated.
- Crypto is `node:crypto` only. A crypto dependency needs an ADR.
- Storage migrations are plain SQL, numbered and forward-only.
- Errors have stable `code` strings and never leak stack traces or local paths over the network. The protocol `version` is bumped on breaking changes, and unknown optional fields are preserved.
- Logs never contain tokens, invitation secrets, private keys, prompts or agent output at the default level. There is no telemetry unless the user opts in.
