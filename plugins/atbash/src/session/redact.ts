/**
 * Secret redaction for the opt-in session context.
 *
 * The session context is built from the Claude Code transcript, which can hold
 * anything a tool printed. It must leave this machine with detected secrets
 * removed, and it must never trip the Atbash judge route's own secret detector:
 * that route refuses a request whose text still "contains a secret", and a
 * refused judge call denies the tool call.
 *
 * So the rules below are a superset of the Dashboard detector
 * (Atbash-Dashboard `src/lib/security/redact-secrets.ts`, mirrored pattern by
 * pattern in DASHBOARD_PATTERNS) plus stricter local rules for shapes that
 * detector and the SDK's native redactor both let through: short `.env`-style
 * passwords, `Authorization` header values of any length, credentials in URLs,
 * secret-bearing CLI flags, unterminated PEM blocks and any hex run of 32+
 * characters.
 *
 * Inputs are bounded by the caller (a few KB per item), so the Dashboard's
 * linear-time matchers, which exist for 64 KiB inputs, are not needed here.
 */

const REDACTED = "[REDACTED]";

interface RedactRule {
  name: string;
  re: RegExp;
  /** Replace only capture group 1, keeping the label around it readable. */
  groupOnly?: boolean;
}

// ── Mirror of the Dashboard detector (same order, same shapes) ─────────────
const CONTEXT_KEYS = String.raw`(?:api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|secret|token|credential|private[_-]?key)`;

export const DASHBOARD_PATTERNS: readonly RedactRule[] = [
  { name: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai_project", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
  { name: "openai", re: /\bsk-[A-Za-z0-9]{20,}/g },
  { name: "github", re: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{30,}/g },
  { name: "google", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: "google_oauth", re: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  {
    name: "aws_access_key",
    re: /\b(?:AKIA|ASIA|AGPA|AROA|ANPA|ANVA|ASCA|AIDA|AIPA)[0-9A-Z]{16}\b/g,
  },
  { name: "stripe", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { name: "slack", re: /\bxox[abprseo]-[A-Za-z0-9-]{10,}/g },
  {
    name: "slack_webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{20,}/g,
  },
  { name: "sendgrid", re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
  { name: "twilio_sid", re: /\bAC[0-9a-fA-F]{32}\b/g },
  { name: "mailgun", re: /\bkey-[0-9a-f]{32}\b/g },
  { name: "npm_token", re: /\bnpm_[A-Za-z0-9]{36,}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: "private_key_pem",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "aws_secret_key",
    re: /(?:aws[_-]?secret|secret[_-]?access[_-]?key)["'\s:=]{1,10}[A-Za-z0-9/+=]{40}/gi,
  },
  {
    name: "labeled_hex_key",
    re: /(?:priv(?:ate)?[_-]?key|secret[_-]?key|agent[_-]?(?:priv|secret)|signing[_-]?key|hex[_-]?key|master[_-]?key|seed)\s*(?:[:=]\s*)?(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/gi,
    groupOnly: true,
  },
  {
    name: "bare_hex_key",
    re: /(?<!(?:brid|b]rid|chain|tx|hash|address|account|block|rid|0x)[:\s=]?)(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g,
  },
  {
    name: "generic_token",
    re: /\b(?!0x[0-9a-fA-F])(?![0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b)(?=[A-Za-z0-9_-]{0,256}[0-9])(?=[A-Za-z0-9_-]{0,256}[A-Za-z])(?![0-9a-fA-F]+$)[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    name: "base64",
    re: /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*[+/])(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[A-Za-z])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g,
  },
  {
    name: "context_secret",
    re: new RegExp(
      String.raw`(?<![A-Za-z0-9_])${CONTEXT_KEYS}["']?\s*[:=]\s*["']?([A-Za-z0-9+/=._-]{12,})(?=["'\s,;)\]}>]|$)`,
      "gi",
    ),
    groupOnly: true,
  },
  {
    name: "bearer",
    re: /(?<![A-Za-z0-9_])Bearer\s+([A-Za-z0-9._-]{20,})\b/gi,
    groupOnly: true,
  },
];

// ── Stricter local rules, applied before the mirror ────────────────────────
// A secret-ish name: a word part such as key, token, secret, password or auth,
// optionally joined to other parts by _ - or . (DB_PASSWORD, api.key, x-auth).
const SECRET_NAME = String.raw`(?:[A-Za-z0-9]+[_.-])*(?:api[_-]?key|apikey|key|keys|token|tokens|secret|secrets|password|passwd|passphrase|pwd|pass|credentials?|auth|authorization|cookie|private[_-]?key)(?:[_.-][A-Za-z0-9]+)*`;

export const LOCAL_PATTERNS: readonly RedactRule[] = [
  // A PEM block cut before its END line (a clipped tool result).
  { name: "private_key_pem_open", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g },
  // The whole value of an Authorization header, whatever its scheme or length.
  {
    name: "authorization_header",
    re: /\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?([^"'\r\n]+)/gi,
    groupOnly: true,
  },
  // user:password@host in a URL.
  {
    name: "url_credentials",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi,
    groupOnly: true,
  },
  // --password hunter2, --token=abc
  {
    name: "cli_secret_flag",
    re: /(?<![A-Za-z0-9_-])--?(?:password|passwd|pass|token|api[_-]?key|secret|auth[_-]?token|access[_-]?token|client[_-]?secret)(?:=|\s+)(?!-)(\S+)/gi,
    groupOnly: true,
  },
  // KEY=value, "key": "value", key: value with a secret-ish name, any length.
  {
    name: "secret_assignment",
    re: new RegExp(
      String.raw`(?<![A-Za-z0-9_.-])${SECRET_NAME}["']?\s*[:=]\s*(?![{\[])("[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;)}\]]+)`,
      "gi",
    ),
    groupOnly: true,
  },
  // Any hex run of 32+ characters (the Dashboard refuses 64; keys come shorter).
  { name: "long_hex", re: /(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g },
];

const ALL_RULES: readonly RedactRule[] = [...LOCAL_PATTERNS, ...DASHBOARD_PATTERNS];

/** A value that is already (the start of) a placeholder from an earlier rule. */
function isPlaceholder(value: string): boolean {
  return /^["']?\[REDACTED/.test(value);
}

function applyRule(text: string, rule: RedactRule): string {
  rule.re.lastIndex = 0;
  if (rule.groupOnly !== true) {
    return text.replace(rule.re, REDACTED);
  }
  return text.replace(rule.re, (full: string, value: unknown) => {
    if (typeof value !== "string" || value === "" || isPlaceholder(value)) {
      return full;
    }
    // A quoted value keeps its quotes so the label stays readable.
    const quoted =
      value.length >= 2 &&
      (value.startsWith('"') || value.startsWith("'")) &&
      value.endsWith(value[0] as string);
    const replacement = quoted ? `${value[0] as string}${REDACTED}${value[0] as string}` : REDACTED;
    const at = full.lastIndexOf(value);
    return at < 0 ? full : `${full.slice(0, at)}${replacement}${full.slice(at + value.length)}`;
  });
}

/** Remove every detected secret from `text`. Never throws on string input. */
export function redactSessionText(text: string): string {
  let working = text;
  for (const rule of ALL_RULES) {
    working = applyRule(working, rule);
  }
  return working;
}

/**
 * True when any rule, local or mirrored from the Dashboard, still matches.
 * Used as the last gate: a payload that still matches is not shared at all.
 */
export function containsSessionSecret(text: string): boolean {
  return ALL_RULES.some((rule) => {
    for (const match of text.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
      // A groupOnly rule whose value is already a placeholder is not a secret.
      if (rule.groupOnly !== true || !isPlaceholder(match[1] ?? "")) {
        return true;
      }
    }
    return false;
  });
}
