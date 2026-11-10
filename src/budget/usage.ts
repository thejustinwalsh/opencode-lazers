import type { Usage } from "./contract.ts"

/** Allow only validated, minimal provider facts across the renderer boundary. */
export function parseGo(body: unknown, now = Date.now()): Usage {
  if (!body || typeof body !== "object" || !("usage" in body)) throw new Error("Invalid usage")
  const usage = body.usage
  if (!usage || typeof usage !== "object") throw new Error("Invalid usage")
  function meter(key: "monthly" | "rolling") {
    const value = (usage as Record<string, unknown>)[key]
    if (!value || typeof value !== "object") throw new Error("Invalid meter")
    const m = value as Record<string, unknown>
    if (
      typeof m.percent !== "number" ||
      !Number.isFinite(m.percent) ||
      m.percent < 0 ||
      (m.status !== "ok" && m.status !== "rate-limited") ||
      typeof m.resetsAt !== "string" ||
      !Number.isFinite(Date.parse(m.resetsAt))
    )
      throw new Error("Invalid meter")
    return { percent: m.percent, resetsAt: new Date(m.resetsAt).toISOString() }
  }
  return {
    status: "available",
    reason: "",
    monthly: meter("monthly"),
    rolling: meter("rolling"),
    observedAt: now,
    creditUSD: null,
    byokUSD: null,
    coverageStart: null,
  }
}

export type UsageFetch = (url: string, options: RequestInit) => Promise<Response>
export async function fetchGo(key: string, signal: AbortSignal, fetcher: UsageFetch = fetch) {
  const response = await fetcher("https://opencode.ai/zen/go/v1/usage", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    redirect: "error",
    signal,
  })
  if (!response.ok) throw new Error("Provider usage is unavailable")
  return parseGo(await response.json())
}

export function ring(percent: number | null) {
  return {
    fraction: percent === null ? 0 : Math.min(100, Math.max(0, percent)) / 100,
    tone:
      percent === null
        ? "unknown"
        : percent >= 90
          ? "critical"
          : percent >= 60
            ? "warning"
            : "normal",
  }
}

/** Calendar arithmetic, not 168 hours: DST weeks can be 167 or 169 hours. Recompute at every read. */
export function localWeek(now = new Date()) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - start.getDay())
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  return {
    start: start.getTime(),
    end: end.getTime(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}
