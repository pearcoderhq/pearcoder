# @pearcoderhq/protocol

## 0.3.0

### Minor Changes

- f1487ce: `@` mentions. Type `@` in the web UI to mention someone or someone's agent (`@Alice's Claude Code`), or write it in `pearcoder say`. Mentions show in the mentioned person's inbox (UI, `pearcoder inbox`, desktop notification with `--notify`) until they reply, for example with `pearcoder say --reply <id>`. A mention of your agent comes with the command to draft an answer (`/pearcoder:discuss <id>`), and your agent sees it in its inbox. The agent never starts on its own.

## 0.2.0

### Minor Changes

- 4d38e53: After `pearcoder attach`, your sessions show your Claude Code or Codex under your name, and people can address a review request to it (UI "Ask for a review", or `pearcoder request --to Alice --for-agent claude`). You can also ask your own agent. The request lands in your inbox with the exact `/pearcoder:review <id>` to run; the agent still only runs when you start it. `attach` now explains the next steps.

## 0.1.0

### Minor Changes

- 41bbba1: Hosts seal every event into a signed hash chain, so `pearcoder verify` catches removed, reordered or re-timed events. A persisted session can only be hosted by one process at a time, and `host --persist` refuses a name you already host. The secret scanner now catches AWS secret keys and credentials in URLs.

### Patch Changes

- f8f914c: `verify` refuses a log whose host seals were stripped, an empty file, and non-JSONL files (one clear message). `github-review` always redacts secrets before showing or posting. `resolve` and `vote` refuse an ambiguous short id instead of picking the first match. A decided decision can only be superseded. `watch` shows titles, notes, dates, agent authorship and replies. `publish` prints the short event id and warns after `--allow-secrets`. `export --out` reports unwritable paths plainly.
