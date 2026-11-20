import { moduleGeneration } from "../core/generation.ts"
import { DecisionProjectionOwner } from "./decision-projection.ts"
import { createThreadedDecisionWorker } from "./decision-worker-client.ts"
import type {
  ThreadedDecisionWorker,
  ThreadedDecisionWorkerOptions,
} from "./decision-worker-client.ts"
import type { ModelDecisionReader } from "./decision-contract.ts"

/**
 * The decision worker of a database, one per process and code generation. OpenCode loads about
 * forty plugin copies into one process, each with its own module scope, so the registry lives on
 * globalThis (like core/registry.ts) and holds plain data and closures only. Every location
 * registers a price-input provider; the worker asks the newest live one, because the saved price
 * sources and OpenRouter access are global, not per location. The last release closes the thread.
 */
/** A late read after release keeps its worker this long without further calls. */
const REVIVE_IDLE_MS = 30_000

const registryKey = Symbol.for("lazers.models.decisionWorker.v1")

type Entry = {
  key: string
  worker: ThreadedDecisionWorker
  providers: Array<ThreadedDecisionWorkerOptions["readPriceInputs"]>
  refs: number
  /** Folds the decision projections on the write connection; the worker only reads them. */
  owner: DecisionProjectionOwner
  /** Projects whose default snapshot this process has already built in the background. */
  prewarmed: Set<string>
}
type Registry = { version: 1; entries: Map<string, Entry> }

const host = globalThis as typeof globalThis & { [registryKey]?: Registry }
const registry = (): Registry => {
  const existing = host[registryKey]
  if (existing?.version === 1) return existing
  return (host[registryKey] ??= { version: 1, entries: new Map() })
}

export type DecisionWorkerLease = {
  reader(projectDirectory: string): ModelDecisionReader
  /** True once per process, code generation and project: the caller builds the first snapshot. */
  claimPrewarm(projectDirectory: string): boolean
  /** Drops this location's reference; the last release closes the worker. Idempotent. */
  release(): void
}

export function acquireDecisionWorker(options: ThreadedDecisionWorkerOptions): DecisionWorkerLease {
  const entries = registry().entries
  const key = `${moduleGeneration()}\u0000${options.path}\u0000${options.workerURL?.href ?? ""}`
  let entry = entries.get(key)
  if (!entry) {
    const providers: Entry["providers"] = []
    const created: Entry = {
      key,
      providers,
      refs: 0,
      prewarmed: new Set(),
      owner: new DecisionProjectionOwner(options.path),
      worker: createThreadedDecisionWorker({
        ...options,
        async readPriceInputs(signal) {
          let failure: unknown
          for (let index = providers.length - 1; index >= 0; index--) {
            try {
              return await providers[index]!(signal)
            } catch (error) {
              signal?.throwIfAborted()
              failure = error
            }
          }
          throw failure ?? new Error("No location can read price inputs")
        },
      }),
    }
    entries.set(key, created)
    entry = created
  }
  const current = entry
  current.refs++
  current.providers.push(options.readPriceInputs)
  let released = false
  let revived: DecisionWorkerLease | undefined
  let reviveTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * A call after the registering scope closed (a cancelled or finished registration) still gets an
   * answer: it takes a fresh lease that lapses after REVIVE_IDLE_MS without calls, so a late read
   * never fails and never keeps a worker alive.
   */
  const revive = () => {
    revived ??= acquireDecisionWorker(options)
    clearTimeout(reviveTimer)
    reviveTimer = setTimeout(() => {
      revived?.release()
      revived = undefined
    }, REVIVE_IDLE_MS)
    reviveTimer.unref()
    return revived
  }
  return {
    reader: (projectDirectory) => {
      const target = () => {
        if (released) return revive().reader(projectDirectory)
        current.owner.touch(projectDirectory)
        return current.worker.reader(projectDirectory)
      }
      return {
        overview: (input, opts) => target().overview(input, opts),
        rows: (input, opts) => target().rows(input, opts),
        configurations: (input, opts) => target().configurations(input, opts),
        inspect: (input, opts) => target().inspect(input, opts),
      }
    },
    claimPrewarm(projectDirectory) {
      if (current.prewarmed.has(projectDirectory)) return false
      current.prewarmed.add(projectDirectory)
      return true
    },
    release() {
      if (released) return
      released = true
      const at = current.providers.indexOf(options.readPriceInputs)
      if (at >= 0) current.providers.splice(at, 1)
      if (--current.refs > 0) return
      if (entries.get(current.key) === current) entries.delete(current.key)
      current.worker.close()
      current.owner.close()
    },
  }
}

/** Diagnostic: live decision workers, their lease counts and registered providers. */
export function decisionWorkerSnapshot() {
  return [...registry().entries.values()].map((entry) => ({
    key: entry.key,
    refs: entry.refs,
    providers: entry.providers.length,
  }))
}
