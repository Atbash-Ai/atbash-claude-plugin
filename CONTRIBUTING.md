# Contributing

## Set up the repository

Use Node.js 22.13.0 or newer and npm 10 or newer.

```bash
npm install
```

## Verification commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run build:marketplace
npm run format:check
npm run verify
```

Run `npm run verify` before opening a pull request. If hook or SDK integration code changes, also regenerate `plugins/atbash/runtime/` with `npm run build:marketplace` and commit the result. CI rejects a stale generated runtime.

## Safety rules

- Never commit an Atbash agent private key or a populated `.env` file.
- Use synthetic credentials and payloads in tests.
- Keep hook standard output reserved for the Claude Code hook protocol.
- Do not weaken the fail-closed behavior.
- Keep enforcement independent of model instructions or skills.
- Review `runtime/manifest.json` and its native binary checksums whenever the pinned SDK changes.

## Behavior boundaries

Changes to activation, hook coverage, decision mapping, internal bypasses, failure behavior, or data sent to Atbash require corresponding documentation and test updates.
