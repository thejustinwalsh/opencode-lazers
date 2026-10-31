export type PrivacyStats = {
  redacted: number
  truncated: number
  unknown: number
  omittedAttachments: number
  omittedReasoning: number
  omittedSystem: number
  omittedUnsupportedParts: number
  compacted: number
}

export const privacyStats = (): PrivacyStats => ({
  redacted: 0,
  truncated: 0,
  unknown: 0,
  omittedAttachments: 0,
  omittedReasoning: 0,
  omittedSystem: 0,
  omittedUnsupportedParts: 0,
  compacted: 0,
})

const MAX_STRING_LENGTH = 4000
const MAX_ARRAY_ITEMS = 40
const MAX_OBJECT_FIELDS = 60
const MAX_DEPTH = 8

const sensitiveKey = (key: string) => {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
  return [
    "auth",
    "authorization",
    "apikey",
    "accesskey",
    "secret",
    "password",
    "passwd",
    "credential",
    "cookie",
    "header",
    "environment",
    "env",
    "token",
    "metadata",
    "native",
    "replay",
    "system",
    "instruction",
    "reasoning",
    "attachment",
    "file",
    "response",
    "rawbody",
    "responsebody",
  ].some((part) => normalized === part || normalized.includes(part))
}

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
  /\b(?:github_pat|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:sk|pk|rk)[-_](?:proj[-_])?[A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:https?|ftp|file):\/\/[^\s<>"')\]}]+/gi,
  /\bwww\.[^\s<>"')\]}]+/gi,
  /(?<![\w.-])((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth(?:orization)?|password|passwd|secret|client[_-]?secret|private[_-]?key)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
]

/** Redact first; truncate only the already-redacted visible string. */
export function safeText(
  value: string,
  stats: PrivacyStats,
  maximum = MAX_STRING_LENGTH,
  depth = 0,
): string {
  let output = value
  const trimmed = value.trimStart()
  if (depth < MAX_DEPTH && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === "object" && parsed !== null)
        output = JSON.stringify(safeValue(parsed, stats, depth + 1))
    } catch {
      // Ordinary prose may start with a brace; continue with pattern redaction.
    }
  }
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0
    output = output.replace(pattern, (...args: string[]) => {
      stats.redacted++
      const match = args[0]!
      const prefix = args.length > 2 && typeof args[1] === "string" ? args[1] : ""
      return `${prefix}[REDACTED]${match.endsWith(".") ? "." : ""}`
    })
  }
  const points = Array.from(output)
  if (points.length > maximum) {
    stats.truncated++
    return `${points.slice(0, maximum).join("")}…[truncated]`
  }
  return output
}

/**
 * Fail-closed JSON projection for visible tool arguments/results. Native data,
 * metadata, credentials, attachments and unknown object types are never copied.
 */
export function safeValue(value: unknown, stats: PrivacyStats, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : "[omitted]"
  if (typeof value === "string") return safeText(value, stats, MAX_STRING_LENGTH, depth)
  if (depth >= MAX_DEPTH) {
    stats.unknown++
    return "[omitted: nesting limit]"
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_ITEMS).map((item) => safeValue(item, stats, depth + 1))
    if (value.length > MAX_ARRAY_ITEMS) stats.truncated++
    return kept
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    stats.unknown++
    return "[omitted: unsupported value]"
  }

  const output: Record<string, unknown> = Object.create(null)
  const entries = Object.entries(value)
  for (const [key, item] of entries.slice(0, MAX_OBJECT_FIELDS)) {
    if (sensitiveKey(key)) {
      stats.redacted++
      continue
    }
    const cleanKey = safeText(key, stats, 100)
    if (/^\[REDACTED\]/.test(cleanKey) || cleanKey.length === 0) {
      stats.redacted++
      continue
    }
    output[cleanKey] = safeValue(item, stats, depth + 1)
  }
  if (entries.length > MAX_OBJECT_FIELDS) stats.truncated++

  // The input is now fully redacted, so bounding the serialized detail cannot
  // allow a secret beyond the retained prefix to escape.
  const serialized = JSON.stringify(output)
  if (serialized.length > MAX_STRING_LENGTH) {
    stats.truncated++
    return `${serialized.slice(0, MAX_STRING_LENGTH)}…[truncated]`
  }
  return output
}

export function safeError(error: unknown, stats: PrivacyStats): string {
  const message = error instanceof Error ? error.message : String(error)
  return safeText(message, stats, 1000)
}
