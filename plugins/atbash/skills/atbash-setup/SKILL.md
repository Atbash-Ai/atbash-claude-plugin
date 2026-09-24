---
name: atbash-setup
description: Set up, connect, verify, troubleshoot, or switch the Atbash Safety profile for Claude Code. Use when the user wants to sign up for Atbash, connect an existing Atbash agent, create a new agent, check setup progress, or repair local plugin configuration.
---

# Atbash Setup

Use the bundled control helper for onboarding. Keep private keys outside the conversation and outside tool arguments. The catch-all `PreToolUse` hook continues to enforce Atbash independently of this skill.

## Start or resume setup

Run the helper through this skill's `scripts/atbash-control.mjs` launcher:

```text
node <skill-directory>/scripts/atbash-control.mjs setup start --host claude
```

The result contains a public `verificationUri`, verification code, and opaque job ID. Show the URL and code to the user and ask them to complete wallet verification in **Connect Atbash**. Never expose files under `~/.config/atbash/pending`, `credentials`, `profiles`, or `hosts`.

Inspect progress with `setup inspect <job-id>` through the same launcher. Follow `nextAction`:

- `OPEN_BROWSER`: the user completes sign-in and wallet verification in the provided page.
- `PREPARE_PLAN`: use discovery to create a non-secret plan JSON file containing only `actions`, then run `setup plan <job-id> --input <path>`.
- `REVIEW_IN_BROWSER`: the user reviews and signs the exact proposal in Connect Atbash. Do not approve it for them.
- `WAIT`: inspect again after the returned poll interval; do not poll after expiry.
- `ACTIVATE`: run `setup continue <job-id>` to decrypt the delivered key locally and activate the profile.
- `RECOVER`: report completed and failed steps. Any replacement mutation requires a new setup or management session and approval.
- `DONE`: run status, then verify one harmless host tool call.

For a new public setup, the plan normally contains `create_account` when missing, `create_organization` when missing, `activate_free_plan` when no subscription exists, then `create_agent` with `keySource: "generate_in_browser"`. Use only values the user supplied or explicitly chose. Do not invent organization names, purposes, risks, or agent names.

## Connect an existing agent

After wallet verification and discovery, run `profile connect <job-id>` through the launcher. Show the returned loopback `localUri` to the user. The user enters the key in that local page. The helper derives its public key and connects it only if discovery shows the verified wallet owns the matching agent. The private key is never sent to Atbash or printed.

Never ask the user to paste, upload, reveal, or dictate a private key. Never read or print credential files. Never put a key in a plan, prompt, environment assignment, command-line argument, committed file, or shell history.

## Profiles and legacy compatibility

List profiles with `profile list --host claude`, select one with `profile switch --host claude --profile <id>`, or disconnect the host mapping with `profile disconnect --host claude`. Disconnecting retains the credential; it does not delete or revoke the on-chain agent.

If there is no selected profile, the hook keeps the legacy SDK configuration behavior. If `ATBASH_AGENT_KEY` or `ATBASH_ORG_NAME` conflicts with a selected profile, report the conflict and ask the user to remove or correct the override locally. Never inspect the conflicting key.

If an already-enabled fail-closed hook blocks setup actions, tell the user to disable the Atbash plugin, run the bundled launcher once outside the guarded session, restart Claude Code, and re-enable the plugin. Do not describe this as bypassing an individual verdict.

## Verify and troubleshoot

Use a harmless tool call such as listing the current directory to verify activation. Status reports `ready`, `configuration_error`, `agent_not_registered`, `agent_jailed`, or `service_error`; it never prints the private key.

- `ALLOW` with `allow: true`: Claude Code continues the pending tool call.
- `HOLD`: Claude Code blocks this attempt pending operator review; the user explicitly retries after approval.
- `BLOCK`: Claude Code blocks the tool call.
- `ERROR`, timeout, malformed output, missing configuration, or inconsistent output: Claude Code blocks because the hook is fail closed.

Do not claim coverage for plain text responses or capabilities outside Claude Code's `PreToolUse` lifecycle hook.
