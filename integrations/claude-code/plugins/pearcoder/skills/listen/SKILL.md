---
name: listen
description: Listen mode. Keeps watch over your Pearcoder sessions with the restricted pearcoder-listen subagent and drafts findings and replies as requests and mentions arrive. Nothing is shared until you approve it.
argument-hint: "[once]"
context: fork
agent: pearcoder:pearcoder-listen
---

Start listen mode for the owner's Pearcoder sessions. Owner's options: `$ARGUMENTS`.

With `once`, handle what is waiting now and stop at the first `inbox_wait` that returns nothing new.

Follow your instructions: wait for new requests and mentions with `inbox_wait`, draft a finding or a reply for each, keep within your limits, and end with a short report. The repository to check claims against is the current working directory.
