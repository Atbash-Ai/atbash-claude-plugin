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
npm run format:check
npm run verify
```

Run `npm run verify` before opening a pull request.

## Safety rules

- Never commit an Atbash agent private key or a populated `.env` file.
- Use synthetic credentials and payloads in tests.
- Keep hook standard output reserved for the Codex hook protocol.
- Do not weaken the fail-closed behavior without updating the architecture contract.
- Keep enforcement independent of model instructions or skills.

## Phase boundaries

The v1 implementation follows the accepted architecture contract. Changes to activation, hook coverage, decision mapping, internal bypasses, failure behavior, or data sent to Atbash require corresponding contract, protocol, and test updates.
