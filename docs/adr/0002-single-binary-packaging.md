# ADR-0002: Single-binary packaging with Node SEA

- Status: accepted
- Date: 2026-10-22
- Plan task: M0.6

## Context

Pearcoder ships as the npm package `pearcoder` and as one downloadable executable per platform (no Node install needed). The executable must contain the Hono server, `ws`, SQLite and the embedded web UI. Two options were tested: `bun build --compile` and Node single executable applications (SEA).

The spike (commit `bca2d56`, `spikes/packaging`, since deleted) built one codebase both ways and ran a smoke test on each platform in GitHub Actions: spawn, wait for the listening line, then exercise the embedded page, SQLite insert/select through `node:sqlite`, and a WebSocket echo. Startup is the median of 7 runs from spawn to listening.

| Platform | Binary | Size | gzip -9 | Startup | All checks |
|----------|--------|------|---------|---------|------------|
| macOS arm64 | Bun 1.4.3 (cross-compiled on Linux) | 70.9 MB | 30.9 MB | 24 ms | pass |
| macOS arm64 | Node 24 SEA | 121.3 MB | n/a | 67 ms | pass |
| Linux x64 | Bun 1.4.3 (cross-compiled) | 90.8 MB | 41.9 MB | 51 ms | pass |
| Linux x64 | Node 24 SEA | 126.8 MB | 43.1 MB | 49 ms | pass |
| Windows x64 | Bun 1.4.3 (cross-compiled) | 96.4 MB | 44.5 MB | 44 ms | pass |
| Windows x64 | Node 24 SEA | 94.1 MB | 35.0 MB | 79 ms | pass |

Locally on an M-series Mac: Bun 21 ms, SEA 44 ms.

Other findings:

- Both runtimes run the same source unchanged, including `node:sqlite`, `@hono/node-server` and `ws`.
- Bun on macOS links the system SQLite (3.51.0 on the test machine), so the SQLite version varies with the macOS version. Node bundles its own (3.53.4) everywhere.
- Bun cross-compiles every target from one runner. SEA must be built on each target OS/arch and needs `postject`, plus signature removal and re-signing on macOS.
- Download sizes after compression are similar (31–45 MB either way).

## Decision

Use **Node SEA** for the standalone binaries.

The deciding factor is one runtime everywhere. Development, tests, the npm package and the binaries all run Node 24, so there is exactly one runtime to test, and the Claude Agent SDK, MCP SDK and `node:sqlite` behave identically in every distribution. With Bun, the npm package would still run on the user's Node while the binaries run on Bun, doubling the compatibility surface for a security-sensitive local agent gateway. The speed and size differences measured here (tens of milliseconds, a few MB compressed) do not matter for a CLI that starts a long-running local node.

## Consequences

- Release workflow (M3.8) builds binaries in a matrix: `macos-latest` (arm64), `macos-13` or equivalent (x64), `ubuntu-latest` (x64), an ARM Linux runner (arm64) and `windows-latest` (x64). Check ARM runner availability and cost for the org when building it.
- Build steps: bundle to one CommonJS file with esbuild (`import.meta.url` shimmed), `node --experimental-sea-config`, copy the `node` binary, inject with `postject`; on macOS remove and re-apply the signature (Developer ID signing and notarization in M3.8). Move to `node --build-sea` when the project's Node version supports it.
- The `pearcoder` npm package bundles the internal `@pearcoderhq/*` packages with the same esbuild step, so they can stay private.
- Built-in modules (`node:sqlite`) are loaded through `createRequire` so the bundler leaves them alone.
- Revisit if binary size becomes a complaint or if Node SEA support regresses.

## Alternatives considered

- **Bun compile:** faster startup, simpler cross-compilation, slightly smaller on macOS. Rejected because it splits the runtime between npm and binary distributions and makes SQLite depend on the macOS version.
- **npm only:** simplest, but needs Node 24 installed, which conflicts with the "one install" goal for non-JS developers. Kept as a distribution channel alongside binaries.
