# Pearcoder threat model

- Status: v1 · 2026-10-22 · Plan task M0.8
- Scope: the local product (M1–M3) in full; the hosted cloud (M4) at outline level
- Inputs: [ADR-0002](adr/0002-single-binary-packaging.md), [ADR-0003](adr/0003-agent-integration-mcp-only.md), docs/invariants.md

Update this document in the same PR as any change to a trust boundary, a new MCP tool, a new network endpoint, or a new stored secret. Every threat has a control and a test ID. A test ID marked *(planned)* must exist before its milestone ships.

## 1. What we protect

| ID | Asset | Where it lives | Worst case if lost |
|----|-------|----------------|--------------------|
| A1 | Owner's machine and repositories (code, `.env`, credentials) | Owner's disk, read by the owner's agent | Code or secret exfiltration; malicious changes |
| A2 | Owner's agent session (Claude Code) | Owner's terminal | Someone else directs the owner's agent |
| A3 | Device private key | `~/.pearcoder/identity/` (0600) | Impersonation in every session |
| A4 | Local owner token (bridge auth) | `~/.pearcoder/` (0600) | Any local process reads drafts or publishes as the owner |
| A5 | Private drafts and inbox | Bridge store on the owner's disk | Unreviewed agent output leaks |
| A6 | Session history (messages, findings, decisions, context packages) | Host node (and cloud in M4) | Confidential design or code leaks to outsiders |
| A7 | Invitation tokens | Shared out of band | Unauthorized join |
| A8 | Release pipeline and npm package | GitHub Actions, npm | Malicious code shipped to every user |
| A9 | Cloud tenant data and billing (M4) | Pearcoder cloud | Cross-tenant leak, fraud |

## 2. Trust boundaries

```
 ┌──────────────────────── Owner's machine ────────────────────────┐
 │  Browser ──TB2──▶ Local node (server/client)  ◀──TB2── other    │
 │                        │ IPC + owner token        local procs   │
 │                        ▼                                         │
 │                     Bridge (drafts, inbox, publish)              │
 │                        ▲ IPC + owner token                       │
 │  Claude Code ──stdio──▶ pearcoder mcp          TB3: agent may be │
 │  (owner's agent)                               prompt-injected   │
 └────────────────────────┬────────────────────────────────────────┘
                          │ TB1: network (LAN / tunnel / cloud)
                          ▼
              Session host node ◀── other participants (TB4)
                          │ TB5 (M4): Pearcoder cloud
 Release pipeline (TB6): GitHub Actions ─▶ npm stage ─▶ owner approval
```

- **TB1, network:** everything from another machine is untrusted until authenticated, and stays untrusted as *content* after that.
- **TB2, browser and other local processes:** a malicious website in the owner's browser, or any other local process, can reach loopback ports.
- **TB3, the owner's agent:** it reads untrusted session content and may follow injected instructions. Pearcoder treats the agent as a semi-trusted client that can at worst write private drafts.
- **TB4, session participants and host:** members are authenticated but may be malicious or compromised. The host orders events and can withhold them.
- **TB5, cloud (M4):** the relay sees session content unless E2EE is added.
- **TB6, supply chain:** dependencies, CI, npm.

## 3. Threats, controls, tests

STRIDE category in brackets: S spoofing, T tampering, R repudiation, I information disclosure, D denial of service, E elevation of privilege.

### 3.1 Remote participants and network (TB1, TB4)

| ID | Threat | Controls | Test | Milestone |
|----|--------|----------|------|-----------|
| T01 [E] | Remote message, mention, artifact or event causes work on someone's agent | Pearcoder never starts agent turns and is never a channel (ADR-0003); no authority-granting event types; notifications to humans only; `no-agent-runtimes` lint rule | `sovereignty.security.test.ts` (planned); `depcruise` rule (exists) | M2 |
| T02 [S] | Participant impersonates another user or agent | Ed25519 device keys; every event signed by its author; agent identity is an owner-signed delegation; host verifies before sequencing, clients verify on receipt | `core/src/identity.security.test.ts`, `protocol/src/signing.security.test.ts`, `core/src/session-log.security.test.ts` (exist) | M1 |
| T03 [T] | Event forged or modified in transit or by the host | Author signatures cover the envelope and payload; TLS on LAN with certificate fingerprint pinned in the invitation | `protocol/src/signing.security.test.ts`, `core/src/session-log.security.test.ts`, `server/test/tls.security.test.ts` (exist) | M1 |
| T04 [T] | Replay of old events or join requests | Idempotent insert by event `id`; signed join challenge with nonce and expiry; per-session sequence | `core/src/session-log.security.test.ts` (event replay), `server/test/server.security.test.ts` (challenge replay) (exist) | M1 |
| T05 [S/E] | Invitation stolen, guessed, reused or forged | Host-signed, expiring, max-use, role-scoped invitations; revocation list; 128-bit secret; shown once | `core/src/invitations.security.test.ts` (exists) | M1 |
| T06 [E] | Member performs actions beyond their role (observer posts, member approves decisions) | Per-event-type ACL in `core`, checked on the host for every event | `core/src/acl.security.test.ts` (exists) | M1 |
| T07 [D] | Flooding, oversized payloads, recursive discussion, huge context packages | Size limits per event and package (256 KB, D7); per-participant rate limits; per-session round limits; WS backpressure | `core/src/session-log.security.test.ts` (size), `core/src/acl.security.test.ts` (rate) (exist); round limits and WS backpressure (planned) | M1, M2 |
| T08 [I] | LAN eavesdropping or a rogue host on the LAN | TLS with pinned fingerprint from the invitation; LAN bind only with `--lan`; LAN is never trusted by default | `server/test/tls.security.test.ts` (exists) | M1 |
| T09 [T/R] | Malicious host reorders, withholds or rewrites history; anyone edits an export | Signatures stop rewriting. The host seals every event into a hash chain (`chain`, signed with the host key), so an export with a removed, reordered, renumbered or re-timed event fails `pearcoder verify`. The host's signed join declares `seals: chain-v1`, so stripping the seals fails too. A host can still withhold events live, or cut a log short at the end (it verifies as a prefix): **accepted residual risk** for self-hosted sessions; cloud hosting in M4 removes a participant as host | `export.test.ts` (sealed history), `sqlite-store.test.ts` (chain survives resume) | M3 |
| T10 [E] | Malformed payload exploits a parser (prototype pollution, schema confusion) | Zod validation on every inbound payload; unknown fields preserved but never interpreted; no `eval`; safe JSON only | `core/src/session-log.security.test.ts` (exists, malformed input); fuzzing (planned) | M1 |

### 3.2 The owner's agent and MCP (TB3)

| ID | Threat | Controls | Test | Milestone |
|----|--------|----------|------|-----------|
| T11 [E] | Prompt injection in session content makes the agent run commands, read secrets or exfiltrate | Content fenced as `<untrusted_session_content author source sha256>` with a warning. One restricted subagent per flow (docs/invariants.md, security rules): `pearcoder-reviewer` (only `finding_draft` can write) and `pearcoder-discuss` (only `reply_draft` can write) get Read/Grep/Glob plus the Pearcoder read tools, with no Bash, network or edits, and output only private drafts. The spike showed Bash unavailable to the subagent (ADR-0003). Requests are informational events with no execution semantics | `mcp/test/mcp.security.test.ts` (exists); live run `e2e/live-review.mjs` on 2026-10-23 with Claude Code 2.1.308 + Haiku: the whole review ran inside `pearcoder:pearcoder-reviewer`, it ignored a planted curl/ssh-key instruction and reported it, saved 2 correct drafts, the session log was unchanged and no key material reached a draft | M2 |
| T12 [I] | Injected agent puts secrets into a draft that the owner then publishes | No MCP publish tool; owner publishes in Pearcoder only; secret scan (keys, tokens, `.env` content, absolute home paths) with redaction preview before publish | `core/src/secret-scan.test.ts`, `mcp/test/mcp.security.test.ts`, `bridge/test/local-node.security.test.ts`, `e2e/tests/review.spec.ts` (exist) | M2 |
| T13b [E] | Codex reviewer: Codex subagents cannot allowlist tools and read files through the shell, so `pearcoder-reviewer` for Codex keeps a shell | Shell confined by `--sandbox read-only` (no writes, no network by default); apps, plugins, memories and permission requests turned off; instructions limit reads to the repository. **Weaker than Claude Code**: the shell can still read files outside the repo the sandbox allows, so a fooled reviewer could copy a secret into a draft. Mitigated by private drafts, the publish secret scan and owner review | `e2e/live-review-codex.mjs` (2026-10-23, Codex 0.160.0): planted curl/ssh-key instruction ignored, 1 correct draft, session unchanged, no key material | M3 |
| T13c [E] | A plugin skill's `agent:` names a subagent without the plugin namespace and Claude Code silently runs a general agent with all tools | Skills use `agent: pearcoder:pearcoder-reviewer` / `pearcoder:pearcoder-discuss`. Found on 2026-10-23: with the bare name, an explicit "run ls with Bash" probe succeeded, while the namespaced name answered "I have no Bash tool". `e2e/live-review.mjs` fails if any subagent Bash call happens; run it with `PEARCODER_LIVE_EXTRA` set to a Bash request after changing skills | Live probe | M2 |
| T13 [E] | Owner uses their main agent instead of the reviewer subagent, which has Bash and broader tools | **Accepted residual risk**: Pearcoder cannot restrict the owner's harness. Mitigations: the UI's "copy review prompt" always uses `/pearcoder:review`; docs explain why; attach never pre-approves Bash or write tools | Docs review | M2 |
| T14 [T] | Agent writes misleading findings (injected or hallucinated) | Drafts are private and attributed to the owner's agent; the owner reviews before publish; findings cite file, line and commit SHA so others can verify | UX review | M2 |
| T15 [E] | Another MCP client or local process calls `pearcoder mcp` tools | stdio only (no listening port); the MCP process authenticates to the bridge with the owner token; drafts are tagged with the calling client | `mcp/test/mcp.security.test.ts` (exists: no publishing tool, session unchanged) | M2 |

### 3.3 The owner's machine (TB2)

| ID | Threat | Controls | Test | Milestone |
|----|--------|----------|------|-----------|
| T16 [E] | A malicious website calls the local node or bridge on loopback (CSRF, DNS rebinding) | Strict `Host` header allowlist (`127.0.0.1`, `localhost`, `[::1]` and the port); `Origin` check on HTTP and WS; no CORS; owner token required on bridge APIs; bridge on unix socket / named pipe where possible; UI session token passed in the URL fragment, never a cookie | `server/test/server.security.test.ts`, `bridge/test/local-node.security.test.ts` (exist: Host, Origin, token, WS) | M1, M2 |
| T17 [I/E] | Another local user or process reads keys, tokens or drafts | `~/.pearcoder` 0700, secret files 0600, permission check on every read with a refusal on wrong mode; Windows ACL equivalent | `core/src/identity.security.test.ts` (exists, POSIX); Windows ACL (planned) | M1 |
| T18 [I] | Context package builder leaks files outside the repo (symlinks, `..`, absolute paths) | Paths resolved and confined to the repo root; symlinks not followed out of the root; `.gitignore`d and secret-pattern files excluded by default; preview before publish | `client/test/context-package.security.test.ts` (exists) | M2 |
| T19 [I] | Logs leak tokens, invitations, keys or draft content | Structured logger with a redaction list; content never logged at default level (docs/invariants.md, engineering rules) | Logger redaction test (planned) | M1 |
| T20 [I] | Telemetry leaks content or identity | Off by default; opt-in only; documented field list; no content, paths or names | Telemetry schema test (planned) | M3 |
| T21 [D] | Host laptop sleeps or crashes, losing the session | Clients replay from persistent cursors; `--persist` SQLite; cloud hosting in M4. Availability, not a security failure | `client/test/client.e2e.test.ts` (host and client restart), `core/src/sqlite-store.test.ts` and `cli.e2e.test.ts` (`--persist`/`--resume`) (exist) | M1, M3 |
| T32 [I] | Session findings reach GitHub without their authors meaning them to be public | Only `pearcoder github-review <pr> --post`, run by a person, posts; without `--post` it prints a preview and a warning. Only findings tied to a package shared from that PR, open ones unless `--include-resolved`. Secrets are always redacted before posting, even in findings that were allowed into the session with `--allow-secrets`. One `COMMENT` review: it never approves or requests changes. Each comment names its author. | `github-review.test.ts` | M3 |
| T33 [E/I] | Addressing "Alice's Claude Code" (a request or an `@` mention) is taken as a command to it, or reveals more than intended | `request.created.for_agent` and `message.created.agent_mentions` are informational, like the rest of a request: it lands in the owner's inbox, and only the owner starts the agent (sovereignty suite unchanged). Presence lists only which harnesses are attached (`claude-code`, `codex`), never activity or prompts. The MCP inbox shows it as fenced data | `protocol.test.ts` (enum), `bridge/test/local-node.security.test.ts` (announcement), `cli.e2e.test.ts` (inbox) | M3 |
| T34 [E] | Listen mode lets session participants steer the owner's agent, or agents keep each other busy | Only the owner starts a run (`/pearcoder:listen`); it runs in the restricted `pearcoder-listen` subagent (no Bash, edits or web; Codex: read-only sandbox) and only writes private drafts, which the owner sends one by one after the secret scan. `inbox_wait` never returns agent-written messages or items that already have a draft; the run stops after 10 items or 20 waits (ADR-0005) | `mcp.security.test.ts` (inbox_wait guards); live `e2e/live-review.mjs haiku listen` on 2026-10-23 with Claude Code 2.1.309: the run stayed in `pearcoder:pearcoder-listen`, refused a requested Bash call, ignored planted curl/ssh-key instructions, drafted 1 finding plus 1 reply, and left the session unchanged ($0.0034) | M3 |
| T35 [I/E] | With auto on (the default), a participant gets the owner's agent to post unreviewed content: code it can read, or text an injected message asks for | Owner-only local setting with a visible banner and one-click off, per session; the local node, not the agent, sends; the secret scan always runs and holds hits as drafts; at most 10 automatic sends per session per hour; only drafts created after auto was switched on; agents never answer agent-written messages; a damaged policy file means off ([ADR-0006](adr/0006-auto-reply.md)). Residual risk: content the scan doesn't recognise | `bridge/test/auto-send.security.test.ts`, `mcp.security.test.ts` (auto off holds items) | M3 |

### 3.4 Supply chain and release (TB6)

| ID | Threat | Controls | Test | Milestone |
|----|--------|----------|------|-----------|
| T22 [T/E] | Malicious or compromised dependency | Lockfile with `--frozen-lockfile`; pnpm minimum release age (never bypassed with `minimumReleaseAgeExclude`); install scripts denied unless reviewed in `allowBuilds`; Dependabot; minimal runtime dependencies (docs/invariants.md, engineering rules); no agent SDKs | CI install (exists) | M0 |
| T23 [T] | Malicious package published to npm as `pearcoder` | npm trusted publishing (OIDC) with **stage-only** permission; every release approved by the maintainer with 2FA; package set to "require 2FA and disallow tokens"; provenance once the repo is public | Release runbook (exists in `release.yml` comments) | M0 |
| T24 [T] | Compromised GitHub Action or workflow | Third-party actions pinned (CLA action by SHA); minimal `permissions` per workflow; `pull_request_target` workflow never checks out PR code; pin all actions by SHA before the repo goes public | Workflow review (planned) | M3 |
| T25 [T] | Tampered standalone binary | Checksums published with releases; macOS Developer ID signing and notarization; Windows signing later; installer verifies checksum | Release smoke test (planned) | M3 |
| T26 [E] | Malicious contribution | CLA, required review, CI incl. `depcruise` security rules and `*.security.test.ts` (never skipped) | CI (exists) | M0 |

### 3.5 Cloud (TB5, M4 outline)

| ID | Threat | Controls (to detail before M4) |
|----|--------|--------------------------------|
| T27 [I] | Cross-tenant data access | Tenant ID on every row and query; row-level security in Postgres; per-tenant object storage prefixes; tests per endpoint |
| T28 [I] | Relay operator or breach reads session content | TLS; encryption at rest; minimal retention; documented access; optional E2EE later (relay sees ciphertext, can still withhold) |
| T29 [S] | Account takeover | GitHub OAuth; SSO/SAML for Enterprise; device keys still sign events, so a stolen web session cannot forge a device's events |
| T30 [D] | Abuse of the hosted relay | Accounts and per-org rate limits; seat limits enforced at invite time |
| T31 [R] | Disputes about who approved what | Signed events plus an append-only audit log per org |

## 4. Accepted residual risks

1. **Host ordering and withholding (T09):** a malicious self-hosted host can delay, drop or reorder events. It cannot forge them.
2. **Unrestricted main agent (T13):** if the owner ignores the reviewer subagent, their main agent may run tools Pearcoder never asked for. Pearcoder only offers read access and private drafts, so the blast radius is the owner's own agent permissions.
3. **Model fallibility (T11, T14):** fencing and restricted tools reduce prompt-injection impact but do not make a model immune. Human review before publish is the final control.
4. **Endpoint compromise:** malware with the owner's user privileges can read keys and drafts. Out of scope for the application.

## 5. Security test conventions

- Security tests are named `*.security.test.ts`, live next to the code or in `test/e2e/`, and must never be skipped (docs/invariants.md, security rules).
- Each test file starts with a comment listing the threat IDs it covers, e.g. `// Covers: T02, T03`.
- Before cloud GA: external penetration test and a review of this document.
