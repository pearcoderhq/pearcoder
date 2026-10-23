# Releasing

Pearcoder ships as one npm package, `pearcoder`. It's a single bundled file (`dist/pearcoder.mjs`) with the web UI and the Claude Code plugin next to it, and it has no runtime dependencies. Internal `@pearcoderhq/*` packages are bundled in and stay private (ADR-0002).

## Steps

1. Run `pnpm changeset` in the PRs that change user-facing behaviour.
2. On `main`:
   - run `pnpm changeset version` and review the bumps and `CHANGELOG.md`;
   - commit;
   - check that `packages/cli/package.json` has the new version.
3. Locally: `pnpm build && pnpm --filter pearcoder smoke:pack`. CI runs the same smoke test on every PR.
4. Create a GitHub release, or run the **Release** workflow by hand. The workflow uses npm trusted publishing (OIDC) to **stage** every non-private package whose version isn't on npm yet. No npm token exists.
5. Approve the staged version. This needs your 2FA passkey:

   ```bash
   npm stage list pearcoder
   npm stage approve <stage-id>
   ```

6. Check: `npx pearcoder@<version> --help`.

## Notes

- Keep the trusted publisher's permission at "npm stage publish" only, and keep package access at "require 2FA and disallow tokens".
- Standalone binaries (Node SEA, ADR-0002) and the Homebrew tap are still to do.
