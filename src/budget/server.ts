import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"
import { Budget, unavailable } from "./contract.ts"
import type { Usage } from "./contract.ts"
import { fetchGo } from "./usage.ts"
import type { UsageFetch } from "./usage.ts"
import { Baseline, fetchCounters, observe } from "./openrouter.ts"

/** No background work: requests alone refresh a short-lived, connection-bound cache. */
type UsageEntry = {
  until: number
  value: Promise<Usage>
  controller: AbortController
  readers: number
  pending: boolean
}

export class UsageCache {
  private entries = new Map<string, UsageEntry>()
  read(
    identity: string,
    load: (signal: AbortSignal) => Promise<Usage>,
    now = Date.now(),
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) return Promise.resolve(unavailable())
    let entry = this.entries.get(identity)
    if (!entry || (!entry.pending && entry.until <= now)) {
      for (const [key, cached] of this.entries)
        if (!cached.pending && cached.until <= now) this.entries.delete(key)
      const controller = new AbortController()
      const created: UsageEntry = {
        until: now + 60_000,
        controller,
        readers: 0,
        pending: true,
        value: Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted()
            return load(controller.signal)
          })
          .catch(() => {
            if (this.entries.get(identity) === created) this.entries.delete(identity)
            return unavailable()
          })
          .finally(() => {
            created.pending = false
          }),
      }
      this.entries.set(identity, created)
      entry = created
    }
    const shared = entry
    shared.readers++
    return new Promise<Usage>((resolve) => {
      let released = false
      const release = (value: Usage) => {
        if (released) return
        released = true
        signal?.removeEventListener("abort", abort)
        shared.readers--
        if (shared.pending && shared.readers === 0) {
          if (this.entries.get(identity) === shared) this.entries.delete(identity)
          shared.controller.abort()
        }
        resolve(value)
      }
      const abort = () => release(unavailable())
      signal?.addEventListener("abort", abort, { once: true })
      void shared.value.then(release)
    })
  }
}

export function registerBudget(
  ctx: Pick<Plugin.Context, "rpc" | "integration" | "storage">,
  fetcher: UsageFetch = fetch,
  cache: UsageCache = new UsageCache(),
) {
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
            async (operationSignal) => {
              const requestSignal = AbortSignal.any([operationSignal, AbortSignal.timeout(15_000)])
              if (input.provider === "go") return fetchGo(key, requestSignal, fetcher)
              const timezoneID = new Bun.CryptoHasher("sha256").update(input.timezone).digest("hex")
              const storageKey = `budget.baseline.${id}.${timezoneID}`
              const saved = await Effect.runPromise(ctx.storage.get(storageKey), {
                signal: requestSignal,
              })
              const previous = Schema.decodeUnknownOption(Baseline)(saved)
              const counters = await fetchCounters(key, requestSignal, fetcher)
              const next = observe(
                previous._tag === "Some" ? previous.value : undefined,
                counters,
                input,
              )
              await Effect.runPromise(ctx.storage.set(storageKey, next.baseline), {
                signal: requestSignal,
              })
              return next.usage
            },
            Date.now(),
            signal,
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
