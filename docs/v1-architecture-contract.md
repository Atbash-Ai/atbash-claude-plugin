# Atbash Codex Plugin: v1 Architecture Contract

- Status: Accepted for implementation
- Date: 2026-07-22
- Repository: `Atbash-Ai/atbash_chatgpt_plugin`
- Plugin identifier: `atbash`
- Display name: `Atbash Safety`
- SDK: npm package `@atbash/sdk@0.6.1`
- Implementation status: Complete; protocol and activation evidence recorded in `hook-protocol-verification.md`

## 1. Purpose

The plugin gates Codex tool calls through Atbash before Codex executes them. Atbash remains responsible for policies, operator review, subscription behavior, enforcement mode, audit records, and verdict generation. The plugin is a thin Codex integration that:

1. observes a pending Codex tool call;
2. submits it through the Atbash SDK;
3. obeys the SDK's canonical decision; and
4. reports the result clearly to Codex and the user.

The plugin does not use a Codex skill to decide when Atbash applies. Enforcement is mechanical and automatic whenever the plugin's hook is active.

## 2. Repository and plugin layout

The Git repository is a repo-local marketplace so a clone can contain both the catalog entry and the plugin source:

```text
atbash_chatgpt_plugin/
├── .agents/plugins/marketplace.json
├── plugins/atbash/
│   ├── .codex-plugin/plugin.json
│   ├── hooks/hooks.json
│   ├── src/
│   ├── tests/
│   ├── package.json
│   └── tsconfig.json
├── docs/
└── README.md
```

The marketplace entry will use:

- plugin name `atbash`;
- source path `./plugins/atbash`;
- installation policy `AVAILABLE`;
- authentication policy `ON_INSTALL`; and
- category `Productivity`.

The plugin will rely on Codex's default discovery of `hooks/hooks.json`. The manifest will not declare a `hooks` field because the current local plugin validator rejects that field.

## 3. Activation contract

The Atbash hook is active only when all of these conditions are true:

1. the `atbash` plugin is installed and enabled;
2. Codex lifecycle hooks are enabled;
3. the user has trusted the current Atbash hook definition.

Valid Atbash configuration is required for an action to receive `ALLOW`, but it is not an activation condition. If the hook is active and configuration is missing or invalid, the hook denies the pending action under the fail-closed policy.

Installing the plugin alone does not silently trust executable hooks. Codex's hook trust review remains part of activation.

When active, Atbash is invoked for every tool call visible to the configured `PreToolUse` hook, except the explicit internal bypasses in section 8. The model does not decide whether to invoke Atbash.

The user deactivates enforcement by disabling the plugin. Codex also permits users to disable or untrust non-managed hooks; doing so makes the guard inactive and Codex is expected to surface that state. Enterprise administrators may later distribute a managed version, but managed enforcement is outside v1.

## 4. Codex enforcement point

The plugin uses one synchronous, command-based `PreToolUse` hook with a catch-all matcher. The hook reads one JSON event from standard input and writes the Codex hook response to standard output.

The hook is responsible for:

- validating the incoming event;
- extracting the tool name and arguments;
- constructing minimal Atbash context;
- calling the SDK before execution;
- translating the SDK decision into the verified Codex hook response; and
- exiting within the configured timeout.

The implementation will use `PLUGIN_ROOT` to resolve installed files rather than assuming the current working directory is the plugin root.

## 5. Enforcement coverage

"Always" means every actionable call exposed through Codex's documented local function-tool hook path.

| Tool path                                  | v1 behavior                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| Shell commands and unified exec            | Judged before the original command starts                              |
| `apply_patch`, `Edit`, and `Write`         | Judged before the edit                                                 |
| MCP tools                                  | Judged before the MCP invocation, except Atbash's own diagnostic tools |
| Other local function tools                 | Judged when Codex routes them through `PreToolUse`                     |
| `write_stdin` for an existing exec session | Not judged again; the originating command was already judged           |
| Hosted tools such as web search            | Outside current Codex hook coverage                                    |
| Specialized tools that opt out of hooks    | Outside current Codex hook coverage                                    |
| Plain model responses with no tool call    | No action exists to judge                                              |

This plugin is a strong lifecycle guardrail, not a complete security boundary. The README must preserve this distinction.

## 6. Published Atbash SDK contract

The implementation uses exactly `@atbash/sdk@0.6.1` from npm for v1. The published package requires Node.js 18 or newer and is server-side only.

### Required enforcement APIs

```ts
import { Atbash } from "@atbash/sdk";

const atbash = Atbash.fromConfig({
  failClosed: true,
  timeoutMs: 30_000,
});

const decision = await atbash.auditToolCall({
  toolName,
  args,
  context,
});
```

Only these SDK entry points are required by the enforcement path:

- `Atbash.fromConfig(options)` for key and environment-backed configuration;
- `Atbash#auditToolCall(input)` for secret redaction, judgment, normalization, and fail-closed decisions; and
- the returned `Decision` fields: `allow`, `verdict`, `reason`, and `toolCallId`.

The plugin will not duplicate the SDK's signing, secret-redaction, verdict-normalization, or endpoint-validation logic.

### Diagnostic APIs

The status command uses the first two methods below. Enforcement does not depend on diagnostics:

- `checkAgentExists()`;
- `getAgentPolicy(atbash.pubkey)`;
- `getJudgmentStatus(toolCallId)`;
- `getPendingHeldActions(orgName, maxCount)`; and
- `getSafetyStats()`.

`judgeAction()` will not be called directly in the v1 hook unless testing demonstrates that `auditToolCall()` cannot preserve a required backend behavior. `auditToolCall()` is the published high-level guard and therefore remains the default integration point.

## 7. Configuration contract

The plugin reads Atbash configuration through `Atbash.fromConfig()`. The supported SDK environment variables are:

- `ATBASH_AGENT_KEY`;
- `ATBASH_ORG_NAME`;
- `ATBASH_ENDPOINT`;
- `ATBASH_BLOCKCHAIN_RID`;
- `ATBASH_PROVIDER`; and
- `ATBASH_PROVIDER_MODEL`.

The SDK may also read its user configuration file and default key file. The plugin will not accept the private key as a Codex tool argument, command-line flag, or hook payload.

The SDK timeout is 30 seconds for v1. The Codex hook timeout will be slightly longer so the SDK can return a controlled `ERROR` decision before Codex terminates the hook. Timeout values may become configurable after baseline latency is measured.

## 8. Event mapping and internal bypasses

The hook maps Codex input to `ToolCallInput` as follows:

| Atbash field | Source                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------- |
| `toolName`   | Codex hook tool name                                                                     |
| `args`       | Parsed Codex tool input without plugin-added serialization                               |
| `context`    | Minimal plugin-generated context describing Codex, workspace, model, and permission mode |
| `resolved`   | Omitted in v1                                                                            |

The hook will not read or send the transcript. It will not add environment variables, private keys, arbitrary file contents, or unrelated conversation text to `context`.

The catch-all hook must bypass Atbash-owned diagnostic MCP tools, identified by an exact namespace controlled by this plugin. This avoids judging health and status calls through the same integration. Calling the SDK directly inside the hook does not create a Codex tool call and therefore does not recurse.

No other user-requested action is bypassed in v1.

## 9. Decision semantics

The plugin obeys the `Decision` returned by `auditToolCall()` rather than recreating backend policy logic.

| SDK decision                       | Codex behavior                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `allow: true`, `verdict: "ALLOW"`  | Continue with the pending tool call                                           |
| `allow: false`, `verdict: "HOLD"`  | Prevent this attempt and surface the reason and `toolCallId`                  |
| `allow: false`, `verdict: "BLOCK"` | Prevent this attempt and surface the reason and `toolCallId` when present     |
| `allow: false`, `verdict: "ERROR"` | Prevent this attempt and report that Atbash could not produce a safe decision |

`auditToolCall()` maps the backend's `No verdict` response to an allowed audit-tier decision. The plugin accepts that behavior because subscription and enforcement mode belong to the Atbash backend and SDK, not to the Codex adapter.

For `HOLD`, the plugin does not auto-execute, auto-retry, or continuously poll. Operator review occurs through Atbash. The user may check status through a later diagnostic tool and explicitly retry the original action after approval.

## 10. Failure policy

The guard is fail closed while active.

The pending tool call must be denied when:

- Atbash configuration is absent or invalid;
- the hook input cannot be parsed safely;
- the SDK cannot reach the judge service;
- the SDK times out;
- the SDK returns an unrecognized result;
- hook-to-SDK mapping fails; or
- the hook cannot construct a valid Codex response after receiving a deny decision.

The user-facing error must distinguish configuration, connectivity, timeout, and malformed-input failures without including secrets.

There is no plugin-level fail-open option in v1. A future fail-open mode would require an explicit architecture change.

## 11. Privacy and security rules

- The private key remains local and is used by the SDK for local signing.
- Secrets must never be printed to stdout or stderr.
- Hook stdout is reserved for the Codex hook protocol.
- Diagnostics log only safe metadata such as tool name, verdict, timing, and redaction counts.
- Raw tool arguments are passed to `auditToolCall()` so its built-in redaction runs before judgment.
- `resolved` remains unused because the SDK documents it as unredacted caller-vouched data.
- Hook output must not contain full arguments, environment values, or transcript content.
- Temporary and test fixtures must use synthetic keys and data.

## 12. Performance model

The v1 hook is a short-lived Node.js process and constructs an `Atbash` client for each intercepted event. This favors correctness and simple packaging over cross-call caching.

Phase 7 will measure process startup and judgment latency. A persistent local daemon may be considered later only if measured overhead is unacceptable. It is not part of v1.

## 13. Explicit non-goals for v1

- Reimplementing Atbash policy evaluation in the plugin
- Teaching Codex when to use Atbash through a skill
- Managing operator approvals inside Codex
- Automatically retrying held actions
- Intercepting hosted tools that Codex does not expose to hooks
- Providing enterprise-managed, non-disableable hooks
- Building a custom UI
- Supporting non-npm Atbash SDKs in this repository
- Sending prompts or transcripts for general monitoring

## 14. Hook validation obligations

Codex documentation states that `PreToolUse` can block or rewrite supported calls, but the implementation must verify the exact event-specific response contract in the target Codex build. Before SDK integration, Phase 3 must demonstrate:

1. the exact allow response;
2. the exact deny response and user-visible reason;
3. what Codex does on hook timeout, process failure, malformed output, and non-zero exit;
4. catch-all matching for shell, patch, MCP, and another local function tool;
5. plugin enable, disable, trust, and changed-hook re-trust behavior; and
6. reliable path resolution through `PLUGIN_ROOT` on supported platforms.

If Codex cannot reliably prevent a supported tool call, Phase 5 must not proceed until the enforcement mechanism is revised.

The implemented wire schema, automated cases, cache execution test, and live Codex deny probe are recorded in [hook-protocol-verification.md](./hook-protocol-verification.md).

## 15. Phase 0 acceptance criteria

Phase 0 is complete when:

- the plugin identity and repository layout are fixed;
- activation and deactivation are explicit;
- the meaning and limits of "always" are documented;
- the npm package version and exact core SDK APIs are fixed;
- verdict and failure semantics are unambiguous;
- privacy, recursion, and timeout rules are documented;
- implementation uncertainties are converted into Phase 3 tests; and
- no skill-based enforcement remains in the design.

## References

- [Atbash SDK on npm](https://www.npmjs.com/package/@atbash/sdk)
- [Codex lifecycle hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex plugin construction](https://learn.chatgpt.com/docs/build-plugins)
