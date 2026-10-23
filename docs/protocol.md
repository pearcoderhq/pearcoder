# Pearcoder protocol

- Version: `1` (`PROTOCOL_VERSION` in `packages/protocol`). Event types are additive, so new types don't change the version.
- Source of truth: Zod schemas in `packages/protocol/src`. JSON Schema comes from `protocolJsonSchemas()`.
- License: Apache-2.0, so any client, host or harness can implement it.

## Identities

Each device has an Ed25519 key pair, created on first run in `~/.pearcoder/identity/device-key.pem`. The file is mode 0600 inside a 0700 directory, and Pearcoder refuses to load it with looser permissions.

| Id | Format | Derived from |
|----|--------|--------------|
| User | `u_` + 26 base64url chars | SHA-256 of the raw 32-byte public key |
| Key | `k_` + 26 base64url chars | same fingerprint as the user id |
| Session | `s_` + 22 base64url chars | 16 random bytes |
| Thread | `main`, or `t_` + 22 base64url chars | 16 random bytes |
| Event | UUID | random |
| Agent | `a_` + 8–64 base64url chars | assigned by the owner; attribution only |

User ids are derived from keys, so nobody can claim an id without its private key. In v1 a user is a device; linking several devices to one account comes with the cloud (M4).

Agents never hold keys or sign anything. When an owner publishes something their agent drafted, the owner's device signs it and sets `actor_agent_id` for attribution (ADR-0003).

## Event envelope

```jsonc
{
  "id": "0b0c…",                    // UUID; the idempotency key
  "session_id": "s_…",
  "timestamp": "2026-10-22T10:00:00.000Z", // author's clock
  "actor_user_id": "u_…",
  "actor_agent_id": "a_…",          // optional
  "type": "message.created",        // dotted lowercase
  "thread_id": "main",
  "reply_to": "…",                  // optional event id
  "version": 1,
  "payload": { "text": "hello" },
  "sig": { "alg": "ed25519", "key_id": "k_…", "value": "<base64url>" },
  // added by the host, not signed:
  "sequence": 1,
  "received_at": "2026-10-22T10:00:00.120Z"
}
```

Unknown fields, in the envelope or in a payload, are preserved, relayed and covered by the signature. Receivers ignore fields they don't understand. Unknown event types are stored and relayed but never interpreted.

## Signing

1. Take the event without `sig`, `sequence`, `received_at` and `chain`.
2. Serialize it as canonical JSON: object keys sorted by UTF-16 code units, no whitespace, `JSON.stringify` formatting for strings and numbers, `undefined` dropped, non-finite numbers rejected.
3. Sign the UTF-8 bytes with Ed25519. Put the base64url signature in `sig.value` and the signer's key id in `sig.key_id`.

Verification recomputes the same bytes and checks both the signature and that `key_id` matches the verifying key. The host's `sequence` and `received_at` sit outside the signature: the host orders events but can't change what an author signed.

## Host rules (v1)

The host appends an event only if all of these hold, and otherwise rejects it with the given code:

| Check | Code |
|-------|------|
| Matches the envelope schema | `INVALID_EVENT` |
| `version` ≤ host's `PROTOCOL_VERSION` | `UNSUPPORTED_VERSION` |
| `session_id` is this session | `WRONG_SESSION` |
| Canonical size ≤ 64 KiB (256 KiB for `context_package.published`) | `EVENT_TOO_LARGE` |
| `actor_user_id` is a registered participant | `UNKNOWN_PARTICIPANT` |
| Signature verifies with that participant's key | `BAD_SIGNATURE` |
| Payload valid, for known event types | `INVALID_PAYLOAD` |
| `id` is new, or identical to the stored event | `EVENT_ID_CONFLICT` |

### Host seal

The host also adds `chain` to every event: `{ prev, hash, sig }`. `prev` is the previous event's `hash`; the first event uses `sha256("pearcoder-chain-v1\n" + session_id)`. `hash` is `sha256` over the lines `pearcoder-chain-v1`, `prev`, `sequence`, `received_at` and the content hash (sha256 of the canonical JSON of the signed event, `sig` included). `sig` is the host's Ed25519 signature over `hash`. Verifiers take the host key from the first event, the host's `participant.joined`. Removing, reordering, renumbering or re-timing any event breaks the chain; a log cut short at the end still verifies as a prefix. The host's own `participant.joined` carries `seals: "chain-v1"`, signed with the rest of the join, so stripping every `chain` field does not pass the log off as one from an older host.

Resending an identical event returns the stored copy with its original `sequence`. `sequence` and `received_at` sent by a client are ignored. This gives at-least-once delivery with idempotent processing. Clients replay with `after=<last sequence>`.

## Roles and permissions

| Role | May append | Notes |
|------|-----------|-------|
| `host` | `message.created`, `presence.changed`, `participant.left`, unknown types | Admits participants through invitations |
| `member` | `message.created`, `presence.changed`, `participant.left`, unknown types | |
| `observer` | `presence.changed`, `participant.left` | Read-only otherwise |

No role can append `participant.joined` directly; it enters only through admission (below). A participant who has left can't append anything until re-admitted with a new invitation. Each participant is rate limited (default burst 20, then 2 events per second) and gets `RATE_LIMITED` beyond that. `presence.changed` may carry `agents` (attached harnesses: `claude-code`, `codex`), and `request.created` may carry `for_agent`, so a request can address someone's agent. `message.created` may carry `mentions` (user ids) and `agent_mentions` (`{user, agent}`) for `@Name` and `@Name's Claude Code`; the host checks that everyone mentioned is a participant. All of these are informational: no event starts an agent. Join and login requests are limited per network address (burst 60, then 5 per second). Other rejection codes: `FORBIDDEN_FOR_ROLE`, `INVALID_JOIN`, and `DECISION_CLOSED` for a stance on a decision that already has an outcome.

## Invitations and admission

An invitation is a token: `pc1_<base64url(canonical JSON)>.<base64url(Ed25519 signature by the host device key)>`. Its JSON contains:

| Field | Meaning |
|-------|---------|
| `v` | `1` |
| `invite_id` | 16 random bytes, base64url. Also the bearer secret |
| `session_id`, `session_name` | The session |
| `host_user_id`, `host_public_key` | Who issued it. The joiner checks that the id derives from the key and the signature verifies |
| `addresses` | 1–8 `http(s)` URLs to reach the host |
| `tls_fingerprint` | Optional `sha256:<hex>` of the host's certificate, pinned by the joiner |
| `role` | `member` or `observer` (never `host`) |
| `expires_at`, `max_uses` | Validity window and use count (1–100) |

Tokens must be canonically encoded, so each invitation has exactly one valid token string. The host keeps a registry and rejects `INVITE_MALFORMED`, `INVITE_BAD_SIGNATURE`, `INVITE_WRONG_SESSION`, `INVITE_UNKNOWN` (not issued by this host), `INVITE_REVOKED`, `INVITE_EXPIRED` and `INVITE_EXHAUSTED`.

To join, the joiner sends the token plus a self-signed `participant.joined` event. Its `public_key` must derive `actor_user_id`, its signature must verify with that key, and its `role` must equal the invitation's role. The host validates the event before consuming an invitation use, so a bad attempt can't burn a single-use invitation. Resending the identical join event returns the stored event, even when the invitation is used up. The host's own `participant.joined` (role `host`) is the first event of every session.

## Transport (HTTP and WebSocket)

The host listens on `127.0.0.1` unless started with an explicit LAN or bind option. Every request must carry an allowed `Host` header (the loopback names with the real port, plus explicitly configured LAN hosts). Requests with an `Origin` header must come from an allowed origin, which defeats CSRF and DNS rebinding. Request bodies are limited to 128 KiB. Errors use the shape `{"error":{"code":"…","message":"…"}}`.

| Method and path | Auth | Purpose |
|-----------------|------|---------|
| `GET /v1/health` | none | `{ ok, protocol_version }` |
| `POST /v1/sessions/:id/join` | invitation | `{ token, event }` → `{ status, event }` |
| `POST /v1/sessions/:id/challenge` | none | `{ client_nonce }` → `{ host_user_id, host_nonce, host_proof, expires_at }` |
| `POST /v1/sessions/:id/token` | proof | `{ user_id, host_nonce, client_nonce, proof }` → `{ token, expires_at }` |
| `GET /v1/sessions/:id/participants` | bearer | current participants |
| `GET /v1/sessions/:id/events?after=&limit=&wait=` | bearer | replay; with `wait` (≤ 30 000 ms) it long-polls until something new arrives |
| `POST /v1/sessions/:id/events` | bearer | a signed event; `actor_user_id` must be the token holder |
| `WS /v1/sessions/:id/stream?after=` | bearer (subprotocol) | live stream |

Join, challenge and token are rate limited per remote address.

### TLS on LAN

Listening beyond loopback requires TLS 1.3 ([ADR-0004](adr/0004-lan-tls-and-certificate-pinning.md)). The host uses either a generated self-signed P-256 certificate (`~/.pearcoder/tls/`) or one the user provides. When an invitation includes `tls_fingerprint` (`sha256:` of the leaf certificate's DER), joiners trust exactly that certificate and nothing else. Without it, they use normal CA validation. Plain `http` is only for loopback.

### Login handshake

1. The client sends a random `client_nonce`.
2. The host returns a one-time `host_nonce` (valid 60 s) and `host_proof`: an Ed25519 signature by the host device key over
   `pearcoder-auth-v1\nhost\n<session_id>\n<host_user_id>\n<client_nonce>\n<host_nonce>`.
   The client verifies it with the `host_public_key` from its invitation, so it knows it reached the right host.
3. The client signs `pearcoder-auth-v1\nclient\n<session_id>\n<host_user_id>\n<user_id>\n<host_nonce>\n<client_nonce>` with its device key and posts it to `/token`.
4. The host checks the nonce is unused, that it was issued for this `client_nonce` and session, that the user is an active participant, and that the proof verifies. It then returns a 256-bit bearer token valid for 12 hours. Tokens stop working when the participant leaves.

The fixed `pearcoder-auth-v1` prefix keeps these signatures distinct from event signatures, which always cover JSON starting with `{`.

### WebSocket stream

Browsers can't set headers on WebSockets, so the client offers the subprotocols `pearcoder.v1` and `pearcoder.auth.<token>`; the server selects `pearcoder.v1`. Server-to-client messages:

- `{ "type": "event", "event": <SequencedEvent> }`, delivered in order, each sequence at most once per connection;
- `{ "type": "ready", "head": n }` after the backlog;
- `{ "type": "ack", "id", "status", "sequence" }` and `{ "type": "error", "id", "code" }` for appends.

Client-to-server: `{ "type": "append", "id": <any>, "event": <SignedEvent> }`. Messages are limited to 128 KiB. Slow consumers with more than 4 MiB buffered are disconnected (close code 1013) and resume from their cursor. Dead connections are detected by a 30 s ping, and the connection closes with code 4001 when the token expires.

## Event types (v1)

| Type | Payload |
|------|---------|
| `participant.joined` | `display_name` (1–80), `public_key` (raw, base64url), `key_id`, `role` (`host`, `member`, `observer`) |
| `participant.left` | `reason?` (≤ 200) |
| `message.created` | `text` (1–16 000), `mentions?` (≤ 50 user ids) |
| `presence.changed` | `state`: `online`, `bridge_connected`, `agent_available`, `agent_busy`, `awaiting_owner`, `offline` |
| `request.created` | `to` (1–20 participant ids), `kind` (`review`, `question`, `discussion`), `title` (≤ 200), `body?` (≤ 16 000), `context_package?` (event id). Rate limited to 10 at once, then 10 per hour, per participant |
| `request.resolved` | `request` (event id), `resolution` (`accepted`, `declined`, `done`), `note?`. Only the requester or an addressee may resolve (`NOT_ADDRESSEE`) |
| `context_package.published` | `title`, `objective`, `constraints[]`, `repo?` (`name`, `url?`, `base?`, `head?` commit SHAs), `paths[]`, `excerpts[]` (`path`, lines, `text`), `body` (Markdown), `version`, `previous?`, `hash`. Up to 256 KiB. `hash` = `sha256:` of the canonical payload without `hash`; hosts reject mismatches |
| `review.finding` | `title`, `severity` (`info`…`critical`), `body`, `request?`, `context_package?`, `location?` (`path`, lines, `commit?`). `actor_agent_id` attributes agent-drafted findings the owner published |

| `finding.resolved` | `finding`, `resolution` (`fixed`, `accepted_risk`, `wont_fix`, `invalid`), `note?`. Only the finding's author, the requester of its request, or the host (`NOT_ADDRESSEE`) |
| `decision.proposed` | `title`, `decision`, `rationale?`, `alternatives?[]`, `related?[]` (event ids that must exist) |
| `decision.vote` | `decision`, `stance` (`agree`, `disagree`, `abstain`), `note?`. Any host or member; the latest stance per person counts |
| `decision.resolved` | `decision`, `outcome` (`accepted`, `rejected`, `superseded`), `note?`. Only the proposer or the host |
| `task.created` | `title` (≤ 200), `body?` (≤ 16 000), `assignee?` (`user`, `agent?`: a person or their agent, a participant), `related?[]`. Rate limited like requests. Assigning someone's agent asks its owner; it starts nothing ([ADR-0007](adr/0007-peer-development.md)) |
| `task.updated` | `task`, and at least one of `status` (`open`, `in_progress`, `blocked`, `done`), `assignee`, `note`. Only the task's creator, its current assignee or the host (`NOT_ADDRESSEE`) |
| `code_ref.published` | `repo` (`name`, `url?` without credentials), `branch`, `commit` (full 40 or 64 hex id), `base?` (full id), `summary` (≤ 4 000), `task?`. Says a commit exists; never carries code. Usually `reply_to` the item it answers |
| `activity.changed` | `agent` (`claude-code`, `codex`), `state` (`idle`, `listening`, `waiting_owner`, `approved`, `working`, `done`, `declined`), `item?` (event id), `edited?`. Published by the owner's local node on change; never carries content |

Replies to a finding or message are `message.created` events with `reply_to` set to its id.

References (`context_package`, `request`, `previous`, `finding`, `decision`, `related`, `task`, `item`) must point at events of the right type in the same session (`INVALID_REFERENCE`). No event type is named or used as an approval of execution: decisions record what people agreed, nothing more.

## Exports

`pearcoder export --format jsonl` writes the signed log, one sequenced event per line. `pearcoder verify` (or `verifyExport`) checks that sequences run 1..n, every author joined with a key that derives their id, and every signature verifies. A host or anyone else can't change signed content without the export failing verification. `--format md` renders the review document: packages with commits, requests, findings by severity with resolution and replies, decisions with stances, and open action items. Participant text is quoted so it can't restructure the document. Requests may only address participants. A request is information for people: nothing in Pearcoder turns one into agent work.

No event type grants execution or authority over another participant's agent, and none ever will (docs/invariants.md, invariant 5).

## Still to specify

The local node client and CLI flows (M1.7–M1.8), and review, artifact and decision events (M2–M3).
