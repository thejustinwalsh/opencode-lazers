import { safeText } from "../trajectory/privacy.ts"
import type { PrivacyStats } from "../trajectory/privacy.ts"

/** Only visible prose is retained, never arbitrary structured context/tool state. */
export function visibleProgressText(value: string, stats: PrivacyStats): string {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed === "object" && parsed !== null) return "[omitted: structured tool content]"
  } catch {
    // Ordinary public prose/tool text is still redacted and bounded below.
  }
  return safeText(value, stats)
}

export function publicProgressError(value: unknown, stats: PrivacyStats) {
  if (value instanceof Error) return { message: visibleProgressText(value.message, stats) }
  if (typeof value !== "object" || value === null) return undefined
  const error = value as Record<string, unknown>
  const type = typeof error.type === "string" ? safeText(error.type, stats, 160) : undefined
  const message =
    typeof error.message === "string" ? visibleProgressText(error.message, stats) : undefined
  return type || message
    ? { ...(type ? { type } : {}), ...(message ? { message } : {}) }
    : undefined
}
