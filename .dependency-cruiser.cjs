// Package boundaries from docs/invariants.md. Never weaken the no-remote-execution rule.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'private-side-stays-local',
      severity: 'error',
      comment:
        'Network-facing and shared packages must never reach the local bridge, which holds drafts and owner approvals (docs/invariants.md, invariant 2).',
      from: { path: '^packages/(server|client|core|protocol|web)/' },
      to: { path: ['^packages/bridge/', '@pearcoderhq/bridge'] },
    },
    {
      name: 'no-agent-runtimes',
      severity: 'error',
      comment:
        'Pearcoder never runs agents: no agent SDKs anywhere (docs/invariants.md, invariant 1, ADR-0003). Integrate through the MCP server instead.',
      from: {},
      to: {
        path: '(^|/)node_modules/(@anthropic-ai/claude-agent-sdk|@anthropic-ai/claude-code|@openai/codex-sdk|@openai/codex)(/|$)',
      },
    },
    {
      name: 'protocol-is-a-leaf',
      severity: 'error',
      comment: 'protocol depends on no other workspace package.',
      from: { path: '^packages/protocol/' },
      to: { path: ['^packages/(?!protocol/)', '@pearcoderhq/'] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)dist/' },
    // TypeScript 7 has no JS compiler API yet, so dependency-cruiser parses .ts with swc.
    parser: 'swc',
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      conditionNames: ['@pearcoderhq/source', 'import', 'types', 'default'],
      exportsFields: ['exports'],
      extensions: ['.ts', '.tsx', '.js', '.json'],
    },
  },
};
