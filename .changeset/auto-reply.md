---
"pearcoder": minor
---

Auto-reply. While `/pearcoder:listen` runs, your agent answers `@` mentions and review requests on its own, and Pearcoder sends its replies after a secret scan. It's on by default, with a banner in the web UI and a one-click "Turn off" per session (or `pearcoder agent auto off`). With auto off, you let your agent handle each item ("Let my Claude Code handle this", or `pearcoder agent allow <id>`) and its replies wait for Send. A draft that trips the secret scan is never sent automatically, at most 10 drafts per session per hour go out automatically, and agents never answer other agents.
