---
name: pearcoder-dev
description: Pearcoder dev mode. Changes code for the user's own Pearcoder items with the pearcoder-dev subagent and pushes the result to a branch. Use when the user asks Codex to work on their Pearcoder tasks.
---

Delegate the whole task to the `pearcoder-dev` subagent. Do not read session content yourself.

Tell it the repository is the current working directory, and pass on `once` if the user wants it to handle what is waiting and stop. When it finishes, relay its report: the branches and commits it pushed, and anything the user should run or check. Never push, post, resolve or vote on the user's behalf outside that subagent.
