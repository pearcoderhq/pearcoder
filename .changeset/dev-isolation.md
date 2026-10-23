---
"pearcoder": patch
---

Dev mode's input isolation is now enforced by the MCP server, not only by the subagent's tool list. While a dev run is working on an item, the tools that return other people's messages refuse. This matters most for Codex, which can't restrict a subagent's tools.
