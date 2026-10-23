---
name: pearcoder-listen
description: Pearcoder listen mode. Keeps watch over your Pearcoder sessions with the pearcoder-listen subagent and drafts findings and replies as requests and mentions arrive. Use when the user asks Codex to listen to Pearcoder.
---

Delegate the whole task to the `pearcoder-listen` subagent. Do not read session content yourself.

Tell it the repository is the current working directory, and pass on `once` if the user wants it to handle what is waiting and stop. When it finishes, relay its report and remind the user to approve the drafts in the Pearcoder web UI or with `pearcoder drafts` and `pearcoder publish`. Never post, resolve or vote on the user's behalf.
