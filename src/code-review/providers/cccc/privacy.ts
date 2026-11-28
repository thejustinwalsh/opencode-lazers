import type { CcccFunctionReport, CcccRawFunctionReport } from "./types.ts"

const CREDENTIAL_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gi,
  /\b(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{8,}\b/gi,
  /\b(?:authorization|password|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*[^\s,;]{8,}/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/gi,
]

function redactCredentialText(value: string): string {
  let safe = value.replace(/\p{Cc}/gu, "")
  for (const pattern of CREDENTIAL_PATTERNS) safe = safe.replace(pattern, "<redacted>")
  return safe
}

export function safeRepositoryPath(value: string): string {
  return redactCredentialText(value)
}

function safeFunctionName(value: string): string {
  if (value.length > 160) return "<redacted-name>"
  return redactCredentialText(value)
}

export function safeFunctionReport(
  fn: CcccRawFunctionReport | CcccFunctionReport,
): CcccFunctionReport {
  return {
    name: safeFunctionName(fn.name),
    kind: safeFunctionName(fn.kind),
    line: fn.line,
    cognitive: fn.cognitive,
    cyclomatic: fn.cyclomatic,
    ...(fn.children?.length ? { children: fn.children.map(safeFunctionReport) } : {}),
  }
}
