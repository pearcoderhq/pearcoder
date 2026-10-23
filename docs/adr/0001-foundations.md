# ADR-0001: Foundations

- Status: accepted
- Date: 2026-10-22

## Context

Pearcoder needed a stack, a license model and a few product principles before any code was written.

## Decision

- A TypeScript monorepo on Node 24 and pnpm.
- An open core: Apache-2.0 for the protocol and integrations, FSL-1.1-ALv2 for the rest, with a CLA.
- Claude Code as the first agent harness, Codex next.
- Review before publish: nothing an agent writes is shared until its owner approves it.
- Ephemeral sessions by default, persistence opt-in.
- Required device keys.
- Markdown and JSON context packages.
- A local node per participant that serves that person's UI.
- Cross-owner PR review as the flagship flow.

Later ADRs record each further architecture decision. Format: context, decision, consequences, alternatives considered.

## Consequences

Changing one of these requires a new ADR that supersedes the relevant part of this one.
