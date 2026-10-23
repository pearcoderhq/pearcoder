# Pearcoder for Claude Code

A Claude Code plugin that lets you review Pearcoder requests in your own Claude Code session.

- `/pearcoder:review [request-id]` runs the review in the **pearcoder-reviewer** subagent. It can use `Read`, `Grep`, `Glob` and Pearcoder's read and draft tools, and nothing else: no shell, no file edits, no web. It saves findings as private drafts.
- `/pearcoder:discuss [id]` runs the **pearcoder-discuss** subagent, with the same restrictions. It drafts replies to findings, objections and questions, checked against your code.
- You review the drafts with `pearcoder drafts` or in the web UI, then publish them. Pearcoder never runs your agent, and the agent can't publish (ADR-0003, docs/invariants.md).

Install it with `pearcoder attach --agent claude`. That command registers the `pearcoder` MCP server for your user and installs this plugin from the local marketplace in this folder. The first time the reviewer uses a Pearcoder tool, Claude Code asks for permission. Choose "always allow" for the Pearcoder tools; plugins can't grant permissions themselves.

License: Apache-2.0.
