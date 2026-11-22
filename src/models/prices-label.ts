/**
 * The Models header's price line: which sources the prices came from, when they were retrieved
 * (with the date unless it is today), and, past the hourly price rule, that they are stale and
 * why (the source's last refresh error, a refresh running, or "not refreshed since").
 */
const PRICE_STALE_MS = 60 * 60 * 1000

type SourceEntry = {
  source: string
  snapshot?: { retrievedAt: string } | null
  refresh?: {
    state: string
    errorCode?: string | null
    httpStatus?: number | null
    completedAt?: string | null
  } | null
}

const NAMES: Record<string, string> = {
  "openrouter-models": "OpenRouter",
  "native-catalog": "OpenCode",
}

const REASONS: Record<string, string> = {
  "missing-credentials": "no access configured",
  "unsupported-credentials": "access not supported",
  "reauthentication-required": "sign-in needed",
  "credential-unavailable": "access unavailable",
  "native-unavailable": "OpenCode catalog unavailable",
  unauthorized: "access refused",
  "rate-limited": "rate limited",
  "server-error": "source server error",
  "http-error": "source answered with an error",
  "malformed-response": "unreadable answer",
  "response-too-large": "answer too large",
  timeout: "timed out",
  "network-error": "network error",
}

export type PricesLabel = { text: string; stale?: string }

function when(time: number, now: number, locale?: string) {
  const at = new Date(time)
  const clock = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
  return at.toDateString() === new Date(now).toDateString()
    ? clock
    : `${at.toLocaleDateString(locale, { day: "numeric", month: "short" })}, ${clock}`
}

/** `used`: the evidence sources the price order reads, in order; one with no prices is skipped. */
export function pricesLabel(
  sources: readonly SourceEntry[],
  used: readonly string[],
  now: number,
  locale?: string,
): PricesLabel | undefined {
  const priced = used
    .map((name) => sources.find((entry) => entry.source === name))
    .filter((entry): entry is SourceEntry & { snapshot: { retrievedAt: string } } =>
      Boolean(entry?.snapshot && Number.isFinite(Date.parse(entry.snapshot.retrievedAt))),
    )
  if (!priced.length) return undefined
  const oldest = priced.reduce((left, right) =>
    Date.parse(right.snapshot.retrievedAt) < Date.parse(left.snapshot.retrievedAt) ? right : left,
  )
  const time = Date.parse(oldest.snapshot.retrievedAt)
  const names = priced.map((entry) => NAMES[entry.source] ?? entry.source).join(", ")
  const text = `${names} prices ${when(time, now, locale)}`
  if (now - time < PRICE_STALE_MS) return { text }
  const refresh = oldest.refresh
  const stale =
    refresh?.state === "refreshing"
      ? "Stale: refreshing now"
      : refresh?.state === "failed" && refresh.errorCode
        ? `Stale: the last refresh failed (${REASONS[refresh.errorCode] ?? refresh.errorCode}${
            refresh.httpStatus ? `, HTTP ${refresh.httpStatus}` : ""
          })`
        : `Stale: not refreshed since ${when(time, now, locale)}`
  return { text, stale }
}
