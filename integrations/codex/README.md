# Pearcoder for Codex

`pearcoder attach --agent codex` sets up three things:

- **MCP server:** `codex mcp add pearcoder -- <node> <pearcoder> mcp`. It reads sessions and saves private drafts, and it can't publish.
- **Subagent:** `$CODEX_HOME/agents/pearcoder-reviewer.toml`, with the shell tool, apps, plugins, memories and permission requests turned off, plus the reviewer instructions.
- **Skill:** `~/.agents/skills/pearcoder-review/SKILL.md`, which hands every Pearcoder review to that subagent.
- **Discussion:** `pearcoder-discuss`, the same pair (subagent and skill) for drafting replies to findings and questions.

Run reviews with a read-only sandbox, for example:

```bash
codex --sandbox read-only            # then: "$pearcoder-review <request-id>"
codex exec --sandbox read-only "Use the pearcoder-review skill for request <request-id>"
```

Codex can't allowlist a subagent's tools the way Claude Code can. It can only turn features off, so the read-only sandbox is part of the protection. The subagent inherits the session's sandbox and approval settings.

License: Apache-2.0.
