---
name: atbash-setup
description: Set up, connect, verify, troubleshoot, or switch the Atbash Safety profile for Claude Code. Use when the user wants to sign up for Atbash, connect an existing Atbash agent, create a new agent, check setup progress, or repair local plugin configuration.
---

# Atbash Setup

Use the bundled control helper for onboarding. Keep private keys outside the conversation and outside tool arguments. The catch-all `PreToolUse` hook continues to enforce Atbash independently of this skill.

## Start or resume setup

Run the helper through this skill's `scripts/atbash-control.mjs` launcher, using the absolute skill directory:

```text
node "<skill-directory>/scripts/atbash-control.mjs" setup start --host claude
```

Until setup activates a profile, the hook allows only these setup steps and denies everything else with "Atbash is not set up yet". Run each helper command as one plain command in exactly this form: no `cd`, `&&`, `;`, pipes, redirection, environment-variable prefixes, or command substitution, and no `--service` option. Commands in any other form are denied.

The result contains a public `verificationUri`, verification code, opaque job ID, and `planPath`. Show the URL and code to the user and ask them to complete wallet verification in **Connect Atbash**, then come back to the conversation. Never expose files under `~/.config/atbash/pending`, `credentials`, `profiles`, or `hosts`.

Inspect progress with `setup inspect <job-id>` through the same launcher. Follow `nextAction`:

- `OPEN_BROWSER`: the user completes sign-in and wallet verification in the provided page.
- `PREPARE_PLAN`: use discovery to build a non-secret plan JSON containing only `actions`. Write it with the Write tool to the job's `planPath` (the only location the helper accepts), then run `setup plan <job-id> --input <planPath>`.
- `REVIEW_IN_BROWSER`: the user reviews and signs the exact proposal in Connect Atbash. Do not approve it for them.
- `WAIT`: inspect again after the returned poll interval; do not poll after expiry.
- `ACTIVATE`: run `setup continue <job-id>` to decrypt the delivered key locally and activate the profile.
- `RECOVER`: report completed and failed steps. Any replacement mutation requires a new setup or management session and approval.
- `DONE`: `setup continue` already reports the new agent's `agentStatus`. Report setup as finished only when `nextAction` is `DONE` and `agentStatus.state` is `ready`. A session `status` of `completed` alone does not mean the profile is active. Do not run another command to check status: from this point every tool call is judged under the new agent's policy, and a blocked call can jail the agent. To confirm enforcement, make one harmless call that fits the agent's purpose, such as reading a file in the workspace with the Read tool rather than a shell command.

For a new public setup, the plan normally contains `create_account` when missing, `create_organization` when missing, `activate_free_plan` when no subscription exists, then `create_agent` with `keySource: "generate_in_browser"`. Use only values the user supplied or explicitly chose. Do not invent organization names, purposes, risks, or agent names.

## Connect an existing agent

After wallet verification and discovery, run `profile connect <job-id>` through the launcher. Show the returned loopback `localUri` to the user. The user enters the key in that local page. The helper derives its public key and connects it only if discovery shows the verified wallet owns the matching agent. The private key is never sent to Atbash or printed.

Never ask the user to paste, upload, reveal, or dictate a private key. Never read or print credential files. Never put a key in a plan, prompt, environment assignment, command-line argument, committed file, or shell history.

## Profiles and legacy compatibility

List profiles with `profile list --host claude`, select one with `profile switch --host claude --profile <id>`, or disconnect the host mapping with `profile disconnect --host claude`. Disconnecting retains the credential; it does not delete or revoke the on-chain agent.

If there is no selected profile, the hook keeps the legacy SDK configuration behavior. If `ATBASH_AGENT_KEY` or `ATBASH_ORG_NAME` conflicts with a selected profile, report the conflict and ask the user to remove or correct the override locally. Never inspect the conflicting key.

Setup runs with the hook enabled; do not ask the user to disable the plugin, which also removes this skill. If the hook denies a setup step because a configuration already exists (invalid, jailed, or not registered), report the exact denial and tell the user they can disconnect the current profile from their own terminal with `node "<skill-directory>/scripts/atbash-control.mjs" profile disconnect --host claude`, then start setup again. Do not describe this as bypassing an individual verdict.

To deactivate Atbash, tell the user to disable or uninstall the plugin from the `/plugin` menu (or run `claude plugin disable atbash` in their own terminal). Do not describe deactivation as bypassing an individual verdict; it disables enforcement for subsequent tool calls. Never try to run that command, edit Claude Code settings, the Atbash config file or the plugin's files, or change `ATBASH_*` variables yourself: the hook denies those tool calls deterministically, before the judge, by design. Tell the user to make the change outside the agent instead.

## Verify and troubleshoot

Use a harmless tool call that fits the agent's purpose, such as reading a workspace file, to verify activation. Status reports `ready`, `configuration_error`, `agent_not_registered`, `agent_jailed`, or `service_error`; it never prints the private key.

- `ALLOW` with `allow: true`: Claude Code continues the pending tool call.
- `HOLD`: Claude Code blocks this attempt pending operator review; the user explicitly retries after approval.
- `BLOCK`: Claude Code blocks the tool call.
- `ERROR`, timeout, malformed output, missing configuration, or inconsistent output: Claude Code blocks because the hook is fail closed.

Do not claim coverage for plain text responses or capabilities outside Claude Code's `PreToolUse` lifecycle hook.
