# ADR-0005: Owner-started listen mode

- Status: accepted
- Date: 2026-10-23
- Amends: docs/invariants.md, invariant 1 (owner sovereignty), ADR-0003

## Context

Trying 0.2.0, the product owner wanted an agent that "gets the messages sent to it and reacts automatically": no typing `/pearcoder:review <id>` for each request, and an answer when someone writes `@Hana's Claude Code`.

docs/invariants.md, invariant 1 said no remote message may cause agent work. Taken literally, that rules out any loop in which session content picks the next thing the agent does, even a loop the owner started on purpose. Full automation (posting replies without the owner) would also break §2.3 (no agent-side publish) and §2.7 (no agent-on-agent loops). It would make every participant able to drive the owner's agent and publish what it reads, so a prompt-injected message could push the owner's code or secrets into the session.

The owner chose the middle option: listen mode where the owner approves every draft.

## Decision

1. **Only the owner starts listening**, inside their own harness: `/pearcoder:listen` in Claude Code, or the `pearcoder-listen` skill in Codex. Pearcoder still never starts, resumes or steers an agent; no remote event can begin a listen run.
2. While a listen run is active, new requests to the owner and messages mentioning the owner's agent may pick the agent's next task. That is the only change to §2.1.
3. The run happens in a **restricted subagent**, `pearcoder-listen`, like every flow (docs/invariants.md, security rules): Read, Grep, Glob and the Pearcoder read tools, `inbox_wait`, `finding_draft` and `reply_draft`. No Bash (Codex: read-only sandbox), no edits, no network.
4. **Drafts only.** Nothing leaves the machine until the owner clicks Send (UI, under the message it answers) or runs `pearcoder publish`. The secret scan still runs first. §2.3 is unchanged.
5. **Loop guards (§2.7).** `inbox_wait` never returns messages written by agents, and never an item the owner already has a draft for (pending, published or discarded). The subagent stops after 10 handled items or 20 waits. Each wait lasts at most 45 seconds.
6. MCP gains one read-only tool, `inbox_wait`. There is still no publish tool.

## Consequences

- The common case is two steps: start `/pearcoder:listen`, then click Send on the drafts that are right.
- An injected message can still steer what a listen run drafts. It can't publish, run commands or leave the read-only boundary. The owner sees every draft before it's sent.
- A listen run costs the owner tokens while it waits, about one short tool call every 45 seconds. Limits keep a forgotten run bounded.

## Alternatives

- **Fully automatic replies** (opt-in, after a secret scan): rejected for now. It turns every participant into someone who can make the owner's agent publish.
- **Keep everything manual**: rejected as too much friction for the flagship flow.
- **Claude Code channels** (push into a running session): still rejected (ADR-0003). They let remote content start turns without an owner-started run.
