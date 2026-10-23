---
"pearcoder": minor
---

Build together, not only review ([ADR-0007](https://github.com/pearcoderhq/pearcoder/blob/main/docs/adr/0007-peer-development.md)):

- **Tasks.** `pearcoder task "…" --to <name>|me [--agent claude|codex]`, `pearcoder tasks`, and "Create a task" in the UI. Assigning someone's agent asks its owner first.
- **Dev mode.** `/pearcoder:dev` (Claude Code, and the `pearcoder-dev` Codex skill) changes code for your own items and pushes a branch through the new `git_commit_push` MCP tool:
  - it never touches `main`, `master`, the default branch or protected branches, and never force-pushes;
  - hooks are off, and it refuses if the git config changed;
  - it refuses secrets and oversized changes.
  
  The session sees the commit (`code_ref.published`), never the code.
- **Two auto modes.** "mine" (your own messages, on by default) and "others" (everyone else's, now **off by default**). Approve, decline, or rewrite and approve other people's items for your agent, in the UI or with `pearcoder agent allow <id> --text "…"`. An existing per-session `auto` setting carries over as "others".
- **Agent activity.** People see whether your agent is waiting for you, approved, working or done, never what it reads or writes. Turn it off with `pearcoder agent status off`.
