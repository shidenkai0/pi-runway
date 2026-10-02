// Secret redaction for outbound review payloads. The reviewer sends bounded
// transcript context and the action payload to the configured Jev provider —
// anything secret-shaped is replaced with [REDACTED:<kind>] BEFORE budgeting,
// truncation, and transmission. Redaction is best-effort defense in depth,
// not a guarantee: the privacy contract (README) states what leaves the
// machine, and minimization comes from the frozen context budgets.

const REDACTED = (kind: string): string => `[REDACTED:${kind}]`

/**
 * Replace secret-shaped spans in text. Applied to transcript entries (before
 * budgeting/truncation) and to every string in the action payload.
 */
export function redactSecrets(text: string): string {
  let out = text

  // Private key blocks (multi-line; must run before generic token rules).
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    REDACTED('private-key'),
  )

  // KEY=VALUE assignments of secret-named variables (.env lines, exports,
  // shell snippets). The variable name must shout (all caps) and carry a
  // secret-shaped suffix; the name is kept for context, the value replaced.
  // Runs before key-shaped rules so assignment context wins the kind label;
  // the value class excludes '[' so already-redacted spans are not re-eaten.
  out = out.replace(
    /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*=\s*["']?)[^\s"'\[]{8,}(["']?)/g,
    (_m, prefix: string, quote: string) => `${prefix}${REDACTED('secret-value')}${quote}`,
  )

  // Provider-shaped API keys.
  out = out
    .replace(/\bsk-or-[A-Za-z0-9_-]{20,}/g, REDACTED('api-key')) // OpenRouter
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED('api-key')) // OpenAI-style
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED('api-key')) // AWS
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED('api-key')) // GitHub
    .replace(/\bgithub_pat_[A-Za-z0-9_]{22,}/g, REDACTED('api-key'))
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED('api-key')) // GitLab
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED('api-key')) // Slack
    .replace(/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED('api-key'))
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED('api-key')) // Google
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED('api-key')) // JWT

  // Authorization: Bearer <token>
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, (_m, prefix: string) => `${prefix}${REDACTED('bearer')}`)

  // Credentials embedded in URLs: scheme://user:pass@host
  out = out.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:]+:)[^/\s@]+@/gi,
    (_m, prefix: string) => `${prefix}${REDACTED('url-credential')}@`,
  )

  return out
}

/**
 * Redact one action-payload value: strings directly; objects via JSON
 * round-trip so nested commands/previews are covered. Unserializable values
 * are replaced wholesale rather than risk leaking nested secrets.
 */
export function redactActionValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value)
  }
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value))) as unknown
  } catch {
    return REDACTED('unserializable')
  }
}
