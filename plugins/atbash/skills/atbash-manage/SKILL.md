---
name: atbash-manage
description: Make an approved change to an existing Atbash agent from Claude Code. Use when the user wants to change an agent name, purpose, risk, or active state, or explicitly requests a new Atbash management authorization.
---

# Atbash Management

Every on-chain change requires a fresh browser authorization. A prior setup, active profile, existing browser login, or agent private key does not authorize a new owner-level mutation.

Start `manage start --host claude` through this skill's `scripts/atbash-control.mjs` launcher. Show the verification URL and code, then inspect the job after wallet verification. Build a non-secret plan JSON with one exact `update_agent` action using the discovered organization, network, and agent public key plus only the fields the user asked to change. Submit it with `manage plan <job-id> --input <path>` through the launcher.

The user reviews and signs the exact change in Connect Atbash. Do not click approval controls or sign for them. Inspect and continue until the receipt is complete. If any approved step partially completed, report it and start a new management session for further work.

Supported changes are agent `name`, `purpose`, `risk`, and `active`. Billing upgrades, ownership transfer, key rotation/recovery, certification, policies, mandate, and accountability require their dedicated dashboard flows until the control API explicitly advertises those actions.

Never read, print, transmit, or ask for an agent private key. Agent keys authorize ordinary Atbash activity only; they do not grant organization-owner permission.
