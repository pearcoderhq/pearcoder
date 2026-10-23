# ADR-0006: Auto-reply

- Status: accepted
- Date: 2026-10-23
- Amends: ADR-0005, invariant 3 in [docs/invariants.md](../invariants.md)

## Context

With listen mode (ADR-0005), the owner still had to click Send on every draft. The product owner wanted it to feel like talking to a teammate's agent: `@Hana's Claude Code review PR 42` gets an answer without Hana in the loop, unless Hana says otherwise. A banner should warn while this is on.

## Decision

1. **A per-session "auto" setting**, stored only on the owner's machine (`~/.pearcoder/agent-policy.json`, 0600). It is **on by default**. Change it in the web UI (banner, "Turn off") or with `pearcoder agent auto on|off [--session]`.
2. **Auto on:** while a listen run is active, new requests and mentions go to the agent without asking. The owner's **local node** sends the agent's drafts on the owner's behalf, signed by the owner with the agent attributed.
   - The agent itself still has no publish tool. The send happens in Pearcoder, under the owner's setting.
   - The secret scan always runs. A draft that trips it stays a draft, and the owner gets a notification.
   - At most 10 drafts per session per hour are sent automatically.
   - Only drafts created after auto was last switched on are sent. Turning auto on never releases old drafts.
3. **Auto off:** each new request or mention waits until the owner lets the agent handle it (the UI's "Let my Claude Code handle this", or `pearcoder agent allow <id>`). The agent's draft then waits for Send.
4. Unchanged: a listen run starts only when the owner starts it; agents never answer agent-written messages; a run handles at most 10 items.
5. A damaged policy file is treated as auto **off**, never as more automatic than intended.

## Consequences

- Anyone in a session where the owner leaves auto on can get the owner's agent to post into that session. A prompt-injected message can make the agent post code it can read, or anything the secret scan doesn't recognise. The banner says this while auto is on, and the listen agent is told that its drafts may be posted unseen.
- Auto-send needs the owner's local node (`pearcoder host` or `pearcoder ui`) to be running. Without it, drafts wait.
- The hourly limit is kept in memory by the local node, so a restart resets it.

## Alternatives

- Off by default with an opt-in. Safer, and still available per session; the product owner chose on by default with a warning.
- Letting the agent publish through an MCP tool. Rejected: it would let a session's content reach the publish step without any Pearcoder-side check.
