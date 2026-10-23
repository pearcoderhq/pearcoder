---
name: pearcoder-discuss
description: Draft replies to findings, objections and questions in a Pearcoder session with the restricted pearcoder-discuss subagent. Use when the user asks to answer or discuss something in Pearcoder.
---

Delegate the whole task to the `pearcoder-discuss` subagent. Do not read session content yourself.

Give it the id from the user's message, if any, and tell it the repository is the current working directory. When it finishes, relay its report and remind the user to review the reply drafts with `pearcoder drafts` or the Pearcoder web UI before anything is posted. Never post, resolve or vote on the user's behalf.
