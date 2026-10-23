# pearcoder

## 0.4.0

### Minor Changes

- 3426cd2: Auto-reply. While `/pearcoder:listen` runs, your agent answers `@` mentions and review requests on its own, and Pearcoder sends its replies after a secret scan. It's on by default, with a banner in the web UI and a one-click "Turn off" per session (or `pearcoder agent auto off`). With auto off, you let your agent handle each item ("Let my Claude Code handle this", or `pearcoder agent allow <id>`) and its replies wait for Send. A draft that trips the secret scan is never sent automatically, at most 10 drafts per session per hour go out automatically, and agents never answer other agents.
- db88ae9: Ask an agent to review from a mention: `@Hana's Claude Code review PR 42`, `… the changes in feat/retry against main`, or `… src/token.ts`. The listen and reviewer agents can now read GitHub PRs (through your `gh` login) and branch diffs (`git diff`), read-only. They draft findings plus a summary reply.

### Patch Changes

- aaa2f9c: Ended sessions show as "ended" in the web UI with a Forget button, and same-named sessions show their short id. `pearcoder attach` now mentions `/pearcoder:discuss` and `/pearcoder:listen`.

## 0.3.0

### Minor Changes

- 5fe65e2: Listen mode: run `/pearcoder:listen` in Claude Code (or ask Codex to use the pearcoder-listen skill). While it runs, your agent drafts a finding for each new review request and an answer for each `@` mention of your agent. Drafts appear in the web UI under the message they answer, with Send, Edit and Discard. Nothing is shared until you send it. `/pearcoder:listen once` handles what's waiting and stops. Agents never answer messages written by other agents, and a run stops after 10 items.
- f1487ce: `@` mentions. Type `@` in the web UI to mention someone or someone's agent (`@Alice's Claude Code`), or write it in `pearcoder say`. Mentions show in the mentioned person's inbox (UI, `pearcoder inbox`, desktop notification with `--notify`) until they reply, for example with `pearcoder say --reply <id>`. A mention of your agent comes with the command to draft an answer (`/pearcoder:discuss <id>`), and your agent sees it in its inbox. The agent never starts on its own.

### Patch Changes

- 1f1eccd: After a host restarts on the same port, the web UI and your agent's MCP server reconnect right away, instead of failing once with "socket hang up".
- c9bf33a: `pearcoder attach` shows up in open sessions within seconds, with no host restart. A session that ended no longer breaks your agent's cross-session inbox: unreachable sessions are skipped and named. A host that wasn't persisted forgets the session when it stops, `pearcoder status` marks hosts it can't reach, and `pearcoder forget <session>` removes an ended one. Asking your own agent skips the accept step, and the card keeps showing the command to run until it's done.

## 0.2.0

### Minor Changes

- 4d38e53: After `pearcoder attach`, your sessions show your Claude Code or Codex under your name, and people can address a review request to it (UI "Ask for a review", or `pearcoder request --to Alice --for-agent claude`). You can also ask your own agent. The request lands in your inbox with the exact `/pearcoder:review <id>` to run; the agent still only runs when you start it. `attach` now explains the next steps.

## 0.1.1

### Patch Changes

- Pearcoder now runs on Node.js 22.13 or newer, not only Node 24. Older Node versions get a clear message instead of a confusing failure. The npm page shows the getting-started guide.

## 0.1.0

### Minor Changes

- bb811d6: `pearcoder github-review <pr>` turns the session's findings about a GitHub PR into one review on that PR: inline comments on lines in the current diff, the rest in the review body. It shows a preview unless you pass `--post`, and it only ever posts a comment review, never an approval.
- 41bbba1: Hosts seal every event into a signed hash chain, so `pearcoder verify` catches removed, reordered or re-timed events. A persisted session can only be hosted by one process at a time, and `host --persist` refuses a name you already host. The secret scanner now catches AWS secret keys and credentials in URLs.
- 4f804b1: New `pearcoder findings` and `pearcoder decisions` listings, and `pearcoder --version`. `watch` shows local times plus titles and short ids for packages, requests, findings and decisions; short ids work for `--package` and `--related`. The host refuses stances on a decided decision. Exports link decisions to the findings they address and keep outcome notes. A failed `join --as` no longer renames you. `--redact` with `--allow-secrets` is an error. The SQLite experimental warning is gone, and the help and messages are clearer.

### Patch Changes

- 9385253: The web UI no longer shows people as online just because they joined: a hollow dot means "joined, not seen online yet", and your own dot follows your live connection. Your local node announces itself again after every reconnect, so a host restart no longer leaves you looking offline.
- f8f914c: `verify` refuses a log whose host seals were stripped, an empty file, and non-JSONL files (one clear message). `github-review` always redacts secrets before showing or posting. `resolve` and `vote` refuse an ambiguous short id instead of picking the first match. A decided decision can only be superseded. `watch` shows titles, notes, dates, agent authorship and replies. `publish` prints the short event id and warns after `--allow-secrets`. `export --out` reports unwritable paths plainly.
