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
npm run build:marketplace        # production runtime (main)
npm run build:marketplace:dev    # development runtime (dev)
npm run format:check
npm run verify
```

Run `npm run verify` before opening a pull request. If hook or SDK integration code changes, also regenerate `plugins/atbash/runtime/` for the branch's environment and commit the result: `npm run build:marketplace:dev` on `dev`, `npm run build:marketplace` for `main`. CI rejects a stale generated runtime and any non-production runtime on `main`. See [Environments and releases](README.md#environments-and-releases).

## Safety rules

- Never commit an Atbash agent private key or a populated `.env` file.
- Use synthetic credentials and payloads in tests.
- Keep hook standard output reserved for the Claude Code hook protocol.
- Do not weaken the fail-closed behavior.
- Keep enforcement independent of model instructions or skills.
- Review `runtime/manifest.json` and its native binary checksums whenever the pinned SDK changes.

## Behavior boundaries

Changes to activation, hook coverage, decision mapping, internal bypasses, failure behavior, or data sent to Atbash require corresponding documentation and test updates.
