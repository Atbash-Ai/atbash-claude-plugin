# Security Policy

## Supported version

Security fixes are currently made against the latest `0.4.x` release line.

## Report a vulnerability

Please use a private [GitHub security advisory](https://github.com/Atbash-Ai/atbash-claude-plugin/security/advisories/new). Do not open a public issue for a suspected vulnerability and do not include an Atbash private key, production tool payload, transcript, or other secret in a report.

Include the affected plugin and Claude Code versions, operating system and CPU architecture, a minimal synthetic reproduction, expected behavior, and observed behavior. We will coordinate disclosure after assessing the report.

## Operational guidance

- Store `ATBASH_AGENT_KEY` in the Atbash SDK user config or a secret-aware environment mechanism.
- Treat the hook command as executable code and review changed definitions before trusting them in Claude Code.
- Keep `@atbash/sdk` pinned. Regenerate and review the committed universal runtime and checksum manifest after dependency changes.
- Do not interpret hook coverage as a complete host sandbox; hosted and opted-out tools may not pass through `PreToolUse`.
