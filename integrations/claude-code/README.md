# Pearcoder for Claude Code

A Claude Code plugin that lets you review Pearcoder requests in your own Claude Code session.

- `/pearcoder:review [request-id]` runs the review in the **pearcoder-reviewer** subagent. It can use `Read`, `Grep`, `Glob` and Pearcoder's read and draft tools, and nothing else: no shell, no file edits, no web. It saves findings as private drafts.
- `/pearcoder:discuss [id]` runs the **pearcoder-discuss** subagent, with the same restrictions. It drafts replies to findings, objections and questions, checked against your code.
- `/pearcoder:listen [once]` runs the **pearcoder-listen** subagent: it keeps watch and drafts findings and replies as requests and mentions arrive (ADR-0005).
- `/pearcoder:dev [once]` runs the **pearcoder-dev** subagent (ADR-0007). It works only on your own words: what you @mention your agent with or assign it in Pearcoder, or someone else's item after you rewrote and approved it. It can `Read`, `Grep`, `Glob`, `Edit` and `Write` in the repository, and pushes through `git_commit_push`, which never pushes the default branch, `main`, `master` or protected branches, never forces, and runs with git hooks off. No shell, no web, and no tools that return other people's messages.
- You review the drafts with `pearcoder drafts` or in the web UI, then publish them. Pearcoder never runs your agent, and the agent can't publish (ADR-0003, docs/invariants.md).

Install it with `pearcoder attach --agent claude`. That command registers the `pearcoder` MCP server for your user and installs this plugin from the local marketplace in this folder. The first time the reviewer uses a Pearcoder tool, Claude Code asks for permission. Choose "always allow" for the Pearcoder tools; plugins can't grant permissions themselves.

License: Apache-2.0.
