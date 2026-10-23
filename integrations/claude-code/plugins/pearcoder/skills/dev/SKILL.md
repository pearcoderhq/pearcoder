---
name: dev
description: Dev mode. Your agent changes code for your own Pearcoder items (your messages to it, tasks you gave it, or others' items you rewrote and approved) in the restricted pearcoder-dev subagent, and pushes to a branch. It never pushes to main or protected branches.
argument-hint: "[once]"
context: fork
agent: pearcoder:pearcoder-dev
---

Start dev mode for the owner's Pearcoder sessions. Owner's options: `$ARGUMENTS`.

With `once`, handle what is waiting now and stop at the first `task_wait` that returns nothing new.

Follow your instructions: take one item at a time with `task_wait`, change the code it asks for in the current working directory, push it with `git_commit_push` (or answer with `reply_draft`), keep within your limits, and end with a short report.
