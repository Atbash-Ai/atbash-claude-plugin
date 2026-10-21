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

For a new setup, the plan normally contains `create_account` when missing, `create_organization` when missing, `activate_free_plan` when no subscription exists, then `create_agent` with `keySource: "generate_in_browser"`. Use only values the user supplied or explicitly chose. Do not invent organization names, organization descriptions, purposes, risks, or agent names; ask for any that are missing before building the plan.

### Plan format

A plan is `{"actions": [...]}` with the actions in the order below. There are no other top-level fields. Every action carries its own `"network"` (`"public"` or `"private"`), and all actions in one plan use the same network. Use a network listed in discovery's `availableNetworks`, which names the networks this Atbash deployment serves: when it lists only one, use it without asking; when it is absent, ask the user. Use exactly these fields:

| Action                | Include when                               | Fields                                                                                                                                                                                   |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_account`      | discovery shows no account on that network | `type`, `network`                                                                                                                                                                        |
| `create_organization` | the organization does not exist yet        | `type`, `network`, `name` (2–64 letters, digits, `.`, `_`, or `-`), `description` (1–280 characters)                                                                                     |
| `activate_free_plan`  | the organization has no subscription       | `type`, `network`, `organization` (the organization's name)                                                                                                                              |
| `create_agent`        | always, for a new agent                    | `type`, `network`, `organization`, `name` (up to 80 characters), `purpose` (up to 280), `risk` (`low`, `medium`, `high`, or `critical`), `keySource` (`"generate_in_browser"`), `policy` |

For example, a new user on a deployment that serves only the private network:

```json
{
  "actions": [
    { "type": "create_account", "network": "private" },
    {
      "type": "create_organization",
      "network": "private",
      "name": "acme_ai",
      "description": "Acme agents"
    },
    { "type": "activate_free_plan", "network": "private", "organization": "acme_ai" },
    {
      "type": "create_agent",
      "network": "private",
      "organization": "acme_ai",
      "name": "claude dev",
      "purpose": "Coding assistant for the Acme repository",
      "risk": "medium",
      "keySource": "generate_in_browser",
      "policy": { "preset": "developer", "version": 1 }
    }
  ]
}
```

Activate the Free plan on the same network as the rest of the plan. If the dashboard answers that the Free plan is available only on the public network, that deployment keeps Free on public: a private organization there needs a paid plan first, so suggest the public network or a plan from the dashboard. If the helper rejects the plan, its error names the action number and the field to fix; correct that field, write the whole plan again, and resubmit it.

Give every new agent a starting policy by adding `"policy": { "preset": "<preset>", "version": 1 }` to its `create_agent` action. Choose the preset from the agent's purpose: `developer` for coding work (the usual choice for Claude Code), `devops` for infrastructure, deployment, or operations work, and `full_baseline` when the user asks for the strictest protection. Tell the user which preset you suggested and that they can switch it on the Connect Atbash review page before approving; the policy they approve is created as the organization policy "<agent name> Policy" and can be fine-tuned later under Policies in the dashboard. If the user wants a different preset before review, resubmit the plan with it.

## Connect an existing agent

After wallet verification and discovery, run `profile connect <job-id>` through the launcher as a background command. Unlike every other setup command, it does not print and exit: it blocks until the key is submitted. Claude Code reports the file its output is written to; read that file with `Read` to get the loopback `localUri` (on older Claude Code versions that report a shell id instead, use `BashOutput`). Setup mode allows reading only that task output file, and stopping the task with `TaskStop` — load it with `ToolSearch` first if it is not yet available — or `KillShell`. Never ask the user to open the output file, `/bashes`, or a second terminal to fetch the link themselves. Show the `localUri` to the user, then read the output again to see whether the submission succeeded. If the user abandons the connection, stop the task and cancel the job as described under **Cancel setup**. The user enters the key in that local page. The helper derives its public key and connects it only if discovery shows the verified wallet owns the matching agent. The private key is never sent to Atbash or printed.

Never ask the user to paste, upload, reveal, or dictate a private key. Never read or print credential files. Never put a key in a plan, prompt, environment assignment, command-line argument, committed file, or shell history.

## Cancel setup

`setup cancel <job-id>`, run through the same launcher, ends a setup job: it cancels the session in Connect Atbash, so its link stops working, and deletes the job's local files, including its session secret. Setup mode allows it.

- Run it when the user asks to stop, cancel, or start over, or abandons setup, while `nextAction` is `OPEN_BROWSER`, `PREPARE_PLAN`, or `REVIEW_IN_BROWSER`. Tell the user setup was cancelled. To start over, run `setup start` for a new job.
- Run it at `RECOVER` when the session was cancelled, rejected, or expired, and for an expired job you will not resume, so its secrets do not stay on disk. If the helper reports that the session had already ended on Atbash, the cleanup still succeeded.
- Do not cancel after the user approved the proposal: approved steps run in the browser and cancelling does not undo them. Let the job finish and report what was created. At `ACTIVATE` the new agent's key is waiting to be activated and the helper refuses to cancel; run `setup continue <job-id>` instead.

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
