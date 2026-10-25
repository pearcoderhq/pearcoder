---
"pearcoder": patch
---

Fix a slow regular expression when stripping credentials from git remote URLs, and check the pinned host certificate inside the TLS probe so an unpinned certificate is never returned.
