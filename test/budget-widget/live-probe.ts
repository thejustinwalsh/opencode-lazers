import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { fetchGo, localWeek } from "../../src/budget/usage.ts"
import { fetchCounters, observe } from "../../src/budget/openrouter.ts"

// Explicit one-shot read, never imported by the test suite. No inference or credential output.
try {
  const endpoint = await Service.discover()
  if (!endpoint) throw new Error("No existing OpenCode service")
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const entries = await client.credential.list({ signal: AbortSignal.timeout(10_000) })
  for (const integration of ["opencode-go", "openrouter"]) {
    const entry = entries.find(
      (e) => e.integrationID === integration && e.active && e.value.type === "key",
    )
    if (!entry || entry.value.type !== "key") throw new Error("Configured provider access missing")
    try {
      const signal = AbortSignal.timeout(15_000)
      if (integration === "opencode-go") {
        const usage = await fetchGo(entry.value.key, signal)
        console.log(
          JSON.stringify({
            provider: "go",
            status: usage.status,
            monthly: usage.monthly,
            rolling: usage.rolling,
          }),
        )
      } else {
        const week = localWeek()
        const first = observe(undefined, await fetchCounters(entry.value.key, signal), week)
        const second = observe(first.baseline, await fetchCounters(entry.value.key, signal), week)
        console.log(
          JSON.stringify({
            provider: "openrouter",
            status: "valid credit + BYOK counters",
            scope: "configured key",
            coverage: "since first probe observation; earlier weekly usage unknown",
            coverageStart: second.usage.coverageStart,
            creditUSD: second.usage.creditUSD,
            byokUSD: second.usage.byokUSD,
          }),
        )
      }
    } catch {
      throw new Error("Provider read failed or returned invalid usage")
    }
  }
} catch {
  console.error(
    "Budget live probe unavailable; no credentials or raw provider responses were retained.",
  )
  process.exitCode = 1
}
