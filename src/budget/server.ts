import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"
import { Budget, unavailable } from "./contract.ts"
import type { Usage } from "./contract.ts"
import { fetchGo } from "./usage.ts"
import type { UsageFetch } from "./usage.ts"
import { Baseline, fetchCounters, observe } from "./openrouter.ts"

/** No background work: requests alone refresh a short-lived, connection-bound cache. */
export class UsageCache {
  private entries = new Map<string, { until: number; value: Promise<Usage> }>()
  read(identity: string, load: () => Promise<Usage>, now = Date.now()) {
    const existing = this.entries.get(identity)
    if (existing && existing.until > now) return existing.value
    for (const [key, entry] of this.entries) if (entry.until <= now) this.entries.delete(key)
    const value = load().catch(() => {
      if (this.entries.get(identity)?.value === value) this.entries.delete(identity)
      return unavailable()
    })
    this.entries.set(identity, { until: now + 60_000, value })
    return value
  }
}

export function registerBudget(
  ctx: Pick<Plugin.Context, "rpc" | "integration" | "storage">,
  fetcher: UsageFetch = fetch,
) {
  const cache = new UsageCache()
  const identity = (key: string) => new Bun.CryptoHasher("sha256").update(key).digest("hex")
  return ctx.rpc.register(Budget, {
    read: (input) =>
      Effect.promise(async (signal) => {
        const integration = input.provider === "go" ? "opencode-go" : "openrouter"
        const resolve = async () => {
          const connection = await Effect.runPromise(
            ctx.integration.connection.active(integration),
            { signal },
          )
          if (!connection || connection.status?.status === "needs_auth") return undefined
          const value = await Effect.runPromise(ctx.integration.connection.resolve(connection), {
            signal,
          })
          return value?.type === "key" && value.key.trim() ? value.key : undefined
        }
        try {
          const key = await resolve()
          if (!key) return unavailable("Connect this provider in OpenCode provider settings.")
          const id = identity(key)
          const result = await cache.read(
            `${integration}:${id}:${input.start}:${input.end}:${input.timezone}`,
            async () => {
              const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
              if (input.provider === "go") return fetchGo(key, requestSignal, fetcher)
              const storageKey = `budget.baseline.${id}`
              const saved = await Effect.runPromise(ctx.storage.get(storageKey), { signal })
              const previous = Schema.decodeUnknownOption(Baseline)(saved)
              const counters = await fetchCounters(key, requestSignal, fetcher)
              const next = observe(
                previous._tag === "Some" ? previous.value : undefined,
                counters,
                input,
              )
              await Effect.runPromise(ctx.storage.set(storageKey, next.baseline), { signal })
              return next.usage
            },
          )
          // An in-flight old connection must never paint over a replacement connection.
          const current = await resolve()
          return current && identity(current) === id
            ? result
            : unavailable("Provider connection changed; refreshing usage.")
        } catch {
          return unavailable("Provider usage is unavailable. It will retry automatically.")
        }
      }),
  })
}
