# Security policy

Pearcoder's core promise is that nobody but you can run your agent, and nothing leaves your machine without your approval. We treat any way around that as a critical vulnerability.

## Reporting a vulnerability

Do not open a public issue. Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. If that option is unavailable, contact a `pearcoderhq` organization owner directly on GitHub and we will set up a private channel.

Include the affected version or commit, steps to reproduce, and the impact you observed. We aim to acknowledge reports within 3 business days and to agree on a disclosure date with you.

## In scope (highest priority first)

1. Any remote input (message, mention, artifact, context package, event, server response) reaching another participant's agent session or causing agent work, or Pearcoder starting an agent turn at all.
2. Agent output, drafts, prompts, local files, keys, or credentials reaching a session without the owner's approval, including any MCP tool path that publishes.
3. Reaching the local bridge from anything other than the owner's machine.
4. Identity spoofing, forged or replayed events, invitation forgery or reuse after revocation.
5. Prompt injection that changes an agent's tools, policy, or workspace.

## Supported versions

Pearcoder is pre-alpha. Only the latest release receives security fixes.
