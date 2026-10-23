# Pearcoder for Codex

`pearcoder attach --agent codex` sets up three things:

- **MCP server:** `codex mcp add pearcoder -- <node> <pearcoder> mcp`. It reads sessions and saves private drafts, and it can't publish.
- **Subagent:** `$CODEX_HOME/agents/pearcoder-reviewer.toml`, with the shell tool, apps, plugins, memories and permission requests turned off, plus the reviewer instructions.
- **Skill:** `~/.agents/skills/pearcoder-review/SKILL.md`, which hands every Pearcoder review to that subagent.
- **Discussion:** `pearcoder-discuss`, the same pair (subagent and skill) for drafting replies to findings and questions.

- **Listen and dev modes:** `pearcoder-listen` (drafts as requests and mentions arrive) and `pearcoder-dev` (changes code for your own Pearcoder items and pushes a branch through `git_commit_push`, ADR-0007).

Run reviews with a read-only sandbox, for example:

```bash
codex --sandbox read-only            # then: "$pearcoder-review <request-id>"
codex exec --sandbox read-only "Use the pearcoder-review skill for request <request-id>"
```

Run dev mode with `codex --sandbox workspace-write`: the subagent edits the repository, its shell has no network, and only `git_commit_push` pushes. Codex can't take the shell away from it, so its instructions limit the shell to reading (threat model T41).

Codex can't allowlist a subagent's tools the way Claude Code can. It can only turn features off, so the read-only sandbox is part of the protection. The subagent inherits the session's sandbox and approval settings.

License: Apache-2.0.
