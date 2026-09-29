# Cursor importing the Claude hook

Cursor 3.20.21 imports enabled Claude plugin hooks and sends `preToolUse`,
`cursor_version`, and `workspace_roots`. It omits Claude's top-level `cwd` and
`permission_mode`. The previous parser rejected ordinary Cursor tool calls before
they could reach the judge with `Atbash ERROR: the hook input was invalid`.

The input adapter accepts that explicit Cursor envelope, validates all workspace
roots as absolute paths, and uses the first workspace root for descriptive context.
A missing permission mode is reported as `unknown`, never as an approval. Tool
names and arguments are forwarded unchanged. No paths or transcripts are read.
Claude input requirements remain unchanged.

Both hosts still require the judge to return `allow: true` and `verdict: ALLOW`.
BLOCK, HOLD, inconsistent decisions, exceptions, malformed inputs, and unavailable
configuration remain denied. Cursor supports the existing nested Claude denial
response. Its workspace governance hooks remain independently active.

Regression coverage uses the observed Cursor envelope without private data,
verifies that the judge is reached, and covers denial and malformed metadata.
Local injected-judge tests do not establish registration or live service access.
Installation and a real harmless Cursor tool call remain separate verification
steps; source tests alone do not prove the installed hook works.

Host reference: https://cursor.com/docs/reference/third-party-hooks
