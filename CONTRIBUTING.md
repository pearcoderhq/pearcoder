# Contributing

Thanks for helping. Pearcoder is pre-alpha and moving fast, so open an issue to discuss anything larger than a small fix before writing code.

## Ground rules

- Read [docs/invariants.md](docs/invariants.md). It applies to humans and coding agents alike, and its invariants are not negotiable.
- One logical change per PR, with Conventional Commit messages (`feat(core): …`).
- Run `pnpm lint && pnpm typecheck && pnpm test` before pushing.
- Add a changeset (`pnpm changeset`) for user-facing changes.
- Fill in the PR template, including **Security impact**.

## Contributor License Agreement

Pearcoder is dual-licensed (see [LICENSE.md](LICENSE.md)) and also runs as a hosted service. To keep that possible, every contributor must sign the [Contributor License Agreement](CLA.md) before their first PR can be merged. You keep the copyright to your contribution.

To sign, read [CLA.md](CLA.md) and post this exact comment on your pull request:

```
I have read the CLA Document and I hereby sign the CLA
```

You only sign once; the CLA bot records it for future PRs. Comment `recheck` if the check does not update.

## Reporting security issues

Never in public issues. See [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
