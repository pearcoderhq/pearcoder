# ADR-0007: Peer development

- Status: accepted
- Date: 2026-10-23
- Amends: ADR-0005, ADR-0006, docs/invariants.md invariants 1 and 3 and the "one restricted subagent per flow" rule

## Context

Pearcoder covers review and decisions. The product owner wants people and their agents to build together in a session too: split work, say who is doing what, and hand work over ("pushed, have a look"). Humans drive this. Pearcoder must not become an orchestrator where agents hand tasks to each other and a human looks in now and then.

Until now, implementing was never a Pearcoder flow: every Pearcoder subagent was read-only and only wrote drafts. The owner implemented in their main session. That meant switching to the agent's terminal for every change, even when the owner just wanted to tell their own agent "fix this and push" from the session.

Two problems blocked this:

1. Sending code through Pearcoder (patches, files) would make Pearcoder a path for malicious patches.
2. ADR-0006 had one auto setting. It couldn't tell "I tell my own agent to do something" apart from "someone else tells my agent to do something". The first is safe to automate; the second isn't.

Nothing here depends on the project's language or build tool. Pearcoder deals only with git and the files in the owner's worktree.

## Decision

### 1. Code moves through git only

- Pearcoder never carries code: no patches, no file contents, no diffs on the wire. Agents and people work in their own checkout, worktree or branch, and push through git as usual.
- A new event, `code_ref.published`, says that a commit exists: repository name and URL, branch, full commit id, an optional base commit, a short summary, and an optional task. It grants nothing (invariant 5).
- The event always carries the full commit id, never a branch name alone. The UI shows that exact commit and warns when a later push to the same branch replaced it ("review that commit, not this one").
- Repository URLs never carry credentials (the protocol rejects `https://user:token@…`), and a local path is never sent as a URL.
- Checking out, building or running someone else's code is always the owner's own action, outside Pearcoder. The UI shows "Bob pushed `abc1234`" as information, with a link to the commit on GitHub, GitLab or Codeberg. Nothing in Pearcoder fetches, checks out or runs it.

### 2. Tasks

- New events `task.created` (title, body, assignee, related events) and `task.updated` (status `open`, `in_progress`, `blocked`, `done`, a new assignee, or a note). An assignee is a person, or a person's agent.
- People create and assign tasks. The task's creator, its current assignee and the host may update it.
- Assigning someone else's agent is a request to that agent's owner (section 4), never an instruction to the agent.
- No automatic handoff: agents never create or assign tasks.

### 3. Two auto modes

ADR-0006's single setting is replaced by two, stored as before in `~/.pearcoder/agent-policy.json`:

| Mode | Covers | Default |
|------|--------|---------|
| **Mine** | Messages, requests and tasks the owner writes to their own agent | On |
| **Others** | Messages, mentions, requests and tasks from anyone else | Off |

- "Written by the owner" means signed by this device's own key, without agent attribution. The local node checks the signature itself; neither a display name nor the host's word counts. A task counts as the owner's only if the owner both wrote and assigned it.
- With a mode on, its items go to the agent while a run is active, and the agent's drafts for them are sent after the secret scan (the ADR-0006 rules: hourly limit, only drafts created after the mode was switched on).
- With a mode off, each item waits for the owner (section 4), and drafts wait for Send.
- Mode **Others** never starts the coding flow (section 5). A code ref only ever goes out under mode **Mine**.
- An ADR-0006 file is migrated: a per-session `auto` becomes `others`. The old global default doesn't carry over, so "others" starts off. A damaged policy file is read as both modes off.

### 4. Owner approval, with edits

- An item aimed at someone's agent lands in that owner's view as **waiting for owner**, unless the matching auto mode is on.
- The owner can approve it, decline it, or rewrite it and approve the rewrite (UI, or `pearcoder agent allow <id> --text "…"`). The rewrite stays on the owner's machine. The agent reads it instead of the original, and it counts as the owner's own words.
- The sender sees the state (section 6): waiting for the owner, approved (with edits), working, done, declined. The sender never sees the owner's rewritten text.

### 5. Coding flow: `pearcoder-dev`

A new restricted subagent, `/pearcoder:dev`, for Claude Code and Codex. It changes code for the owner without the owner switching to their terminal.

- **Trigger:** only items in the owner's own words: what they wrote (mode Mine on, or approved), or their rewrite of someone else's item. It runs only inside a run the owner started; no remote event starts it. While a dev run is active, the owner's own items go to it and not to listen mode.
- **Input isolation:** its wait tool, `task_wait`, returns only the owner's words. The subagent has no tool that returns other people's session content (`session_read`, `inbox_wait`, `request_get` and the like are disallowed). The MCP server enforces this too: while its process holds an open dev item, those tools refuse, which also covers Codex, where tools can't be restricted. Text the owner quotes into their item is theirs: quoting it is vouching for it.
- **Tools:** `Read`, `Grep`, `Glob`, `Edit`, `Write`, `task_wait`, `git_commit_push`, `reply_draft`, `drafts_list`, `git_diff`. No Bash, no web.
- **`git_commit_push` (MCP tool).** The tool checks every limit itself, so nothing depends on the model behaving:
  - it refuses unless the item was handed to this dev run by `task_wait`, and it checks again, against the session as it is now, that the item is in the owner's own words;
  - it commits everything changed in the worktree and pushes only the current branch (or `new_branch`, created from HEAD) to that branch's existing remote. It never adds or changes remotes;
  - it never force-pushes, and never pushes to the remote's default branch, `main`, `master`, or branches the owner lists as protected;
  - git hooks are off for every call (`core.hooksPath` points to an empty folder, plus `--no-verify`), because a repository can version hooks (husky and the like) and the agent can edit them. `core.fsmonitor` is off;
  - when the dev run picks up an item, the tool records a hash of the repository's git config. It refuses if that hash changed before the push, because the agent's `Write` could otherwise plant an alias, a filter or `sshCommand` in `.git/config`;
  - it runs the secret scan on the added lines and refuses (and unstages) changes that look like secrets;
  - it enforces a per-push limit on files and changed lines (default 50 and 2,000, configurable in the policy file) and at most 5 pushes per item;
  - after the owner presses Stop, it refuses to push for that item.
- The tool returns the new commit and saves a `code_ref` draft. The owner's local node sends it under mode Mine, as a reply to the item.
- **Limits:** one item at a time, at most 5 items or 20 waits per run, and a Stop button in the UI (`pearcoder agent stop <id>`).
- **Codex** can't allowlist subagent tools. Its `pearcoder-dev` runs with `--sandbox workspace-write`, so its shell can still run commands inside the repository without network access. Its instructions limit the shell to reading. That's weaker than Claude Code (threat model T41).
- **Not included:** running builds, tests or any other command. Those need a shell, and a shell brings back the arbitrary-command risk. The owner runs them, or a later ADR adds them.

### 6. Agent activity

The owner's local node publishes `activity.changed` for its attached agent, on change only:
- `waiting_owner`, `approved` (with `edited`), `working`, `done` and `declined` for a given item;
- `listening` or `idle` overall.

It never carries prompts, tool calls, output or the owner's rewritten text. The owner can turn it off per session (UI, or `pearcoder agent status off`). The event name avoids "agent", "run" and similar words, so no event type reads as an instruction (invariant 5).

## Consequences

- Building together no longer means switching terminals for every change: the owner tags their own agent or gives it a task, it edits, commits and pushes to a branch, and the session sees the commit.
- Malicious code can't travel through Pearcoder. It still travels through git, under the same trust people already give a colleague's branch or PR.
- The writing agent never sees other people's text unless its owner passes it on. A prompt injection would have to come through the owner's own words, or through files already in the repository. That residual risk is accepted: it's the same as the owner's own agent today.
- A stolen owner device key would let an attacker make the owner's agent push to non-protected branches while a dev run is active. Keys stay `0600` and revocable, and the push limits bound the damage.
- Sharing activity reveals when someone's agent is busy. That's why it can be turned off per session.
- Others' items are now off by default, a change from ADR-0006 (on by default). Owners who relied on that turn "others" on again per session.

## Alternatives

- **Send patches through Pearcoder.** Rejected: it makes Pearcoder a path for malicious code and duplicates git.
- **Give `pearcoder-dev` Bash.** Rejected: it would allow any command, including from an injected task. A narrow push tool covers the common case.
- **Automatic handoff between agents.** Rejected for now: it moves control from people to agents. It can come back as its own decision.
- **Keep one auto setting.** Rejected: it treats the owner and everyone else the same.
- **Let mode Others start the coding flow.** Rejected: anyone in the session could then make the owner's agent push code.
- **A dev subagent that also reads the session.** Rejected: an agent with write access must not read untrusted text.
