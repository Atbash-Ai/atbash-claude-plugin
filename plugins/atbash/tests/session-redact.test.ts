import assert from "node:assert/strict";
import test from "node:test";

import { containsSessionSecret, redactSessionText } from "../src/session/redact.js";

// Every positive case of Atbash-Dashboard tests/unit/redact-secrets.test.ts:
// the judge route refuses a request whose text its containsSecret flags, so
// each of these must be flagged here and gone after redaction.
//
// Provider-shaped samples are assembled at run time with k(): the fake keys
// never sit in the source as one literal, so secret scanners (GitHub push
// protection) do not mistake these test fixtures for leaked credentials. The
// strings the assertions see are unchanged.
const k = (...parts: string[]): string => parts.join("");
const DASHBOARD_POSITIVES: ReadonlyArray<[string, string]> = [
  ["openai", `api key is ${k("sk-", "abcdefghijklmnopqrstuvwxyz0123")} ok?`],
  ["openai_project", `token: ${k("sk-proj-", "aaaabbbbccccddddeeeeffff")}`],
  ["anthropic", `send: ${k("sk-ant-api03-", "AAAAAAAAAAAAAAAAAAAAAAAAA")}`],
  ["github", `export GH=${k("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789")}`],
  ["github_pat", `GITHUB_TOKEN=${k("github_pat_", "11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678")}`],
  ["google", `key=${k("AIza", "SyA-1234567890abcdefghijklmnopqrstuvw")}`],
  ["google_oauth", `found ${k("ya29.", "AAAAAAAAAAAAAAAAAAAAAAAA")} in log`],
  ["aws_access_key", `${k("AKIA", "IOSFODNN7EXAMPLE")} is the access key`],
  ["aws_access_key_asia", k("ASIA", "IOSFODNN7EXAMPLE")],
  ["aws_access_key_agpa", `${k("AGPA", "IOSFODNN7EXAMPLE")} creds`],
  ["aws_secret_key", `aws_secret=${k("AbCdEfGhIjKlMnOpQrStUv", "WxYz0123456789AbCd")}`],
  ["aws_secret_access_key", `secret_access_key: "${k("AbCdEfGhIjKlMnOpQrStUv", "WxYz0123456789AbCd")}"`],
  ["stripe", `stripe: ${k("sk_", "live_", "51HxAbCdEfGhIjKlMnOpQrStUv")}`],
  ["stripe_pk_test", k("pk_", "test_", "51HxAbCdEfGhIjKlMnOpQrStUv")],
  ["slack", k("xoxb-", "1234567890-abcdef")],
  ["slack_xoxe", k("xoxe-", "1234567890-abcdef")],
  [
    "slack_webhook",
    `post to ${k("https://hooks.slack.com/", "services/", "T012ABCDE/B012ABCDE/AbCdEfGhIjKlMnOpQrStUvWx")} now`,
  ],
  ["sendgrid", `${k("SG.", "aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb")} is the key`],
  ["twilio_sid", `twilio ${k("AC", "0123456789abcdef0123456789abcdef")} test`],
  ["mailgun", `mailgun ${k("key-", "0123456789abcdef0123456789abcdef")} test`],
  ["npm_token", `export NPM_TOKEN=${k("npm_", "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AB")}`],
  [
    "jwt",
    "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ],
  [
    "private_key_pem",
    "config:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\nend",
  ],
  ["generic_token", "token=Xy7Pq9Rs2Tu4Vw6Xy8Az0Bc2De4Fg6Hi"],
  ["generic_token_32", "abcdefghijklmnopqrstuvwxyz123456"],
  ["uuid_prefixed_token", "79ee71e9-5593-42bc-9116-fd3691fbe331AABBCC"],
  ["labelled_uuid", "api_key: 79ee71e9-5593-42bc-9116-fd3691fbe331"],
  ["base64", "payload=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+1234567890+abcdefghij/== done"],
  ["context_secret", "password=hello1234567890"],
  ["context_secret_json", '{"api_key":"my-secret-12345-value"}'],
  ["bearer", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123"],
  ["bare_hex_key", `sha ${"a3f1".repeat(16)}`],
  ["labeled_hex_key", `private_key=${"0f".repeat(32)}`],
  ["url_query", "https://api.example.com/v1?key=sk-abcdefghijklmnopqrstuvwxyz0123&user=alice"],
];

test("flags and removes every Dashboard containsSecret positive case", () => {
  for (const [name, sample] of DASHBOARD_POSITIVES) {
    assert.equal(containsSessionSecret(sample), true, `${name} not detected`);
    const redacted = redactSessionText(sample);
    assert.equal(containsSessionSecret(redacted), false, `${name} survived: ${redacted}`);
    assert.match(redacted, /\[REDACTED\]/, name);
  }
});

// Shapes the SDK's native redactor and the Dashboard detector both let
// through (checked against SDK 0.7.1 and 0.9.1): removed here regardless.
const LOCAL_POSITIVES: ReadonlyArray<[string, string, string]> = [
  ["short env password", "DB_PASSWORD=hunter2", "hunter2"],
  ["quoted env secret", 'export STRIPE_SECRET="abc def"', "abc def"],
  ["yaml password", "password: s3cret!", "s3cret!"],
  ["json token", '{"refresh_token": "r1"}', "r1"],
  ["basic auth header", "Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
  ["short bearer header", "authorization: Bearer abc", "abc"],
  ["url credentials", "postgres://admin:s3cr3tpass@db.local/app", "s3cr3tpass"],
  ["cli password flag", "mysql --password hunter2 -u root", "hunter2"],
  ["cli token flag", "gh auth login --token=gho_short", "gho_short"],
  [
    "unterminated pem",
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0",
    "MIIEvQIBADANBgkqhkiG9w0",
  ],
  ["40-hex token", `ghtoken ${"b".repeat(20)}${"1".repeat(20)}`, "bbbbbbbbbbbbbbbbbbbb1111"],
  ["pure-hex 64 key", "deadbeef".repeat(8), "deadbeef"],
];

test("removes secret shapes the SDK and Dashboard miss", () => {
  for (const [name, sample, secret] of LOCAL_POSITIVES) {
    assert.equal(containsSessionSecret(sample), true, `${name} not detected`);
    const redacted = redactSessionText(sample);
    assert.equal(redacted.includes(secret), false, `${name} survived: ${redacted}`);
    assert.equal(containsSessionSecret(redacted), false, `${name} still flagged: ${redacted}`);
  }
});

test("keeps the label readable and is idempotent", () => {
  const once = redactSessionText('DB_PASSWORD=hunter2 and {"api_key":"my-secret-12345-value"}');
  assert.equal(once, 'DB_PASSWORD=[REDACTED] and {"api_key":"[REDACTED]"}');
  assert.equal(redactSessionText(once), once);
  assert.equal(containsSessionSecret(once), false);
});

test("leaves ordinary work text alone", () => {
  for (const sample of [
    "Add a section about installation to README.md",
    "npm test -- --watch=false",
    "send email to alice@example.com about the report",
    "git log --oneline -5",
    "79ee71e9-5593-42bc-9116-fd3691fbe331",
    "src/hook/context.ts",
    "order #12345",
  ]) {
    assert.equal(containsSessionSecret(sample), false, sample);
    assert.equal(redactSessionText(sample), sample);
  }
});
