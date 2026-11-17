import { CapabilityHub } from "./capabilities.ts"

/**
 * Process-wide, refcounted core registry. OpenCode loads every location with a fresh
 * module copy, so the registry lives on globalThis and stores only plain data and
 * closures: nothing here relies on class identity across copies.
 */
const registryKey = Symbol.for("lazers.core.v1")

type Entry = {
  key: string
  refs: number
  value: unknown
  hub: CapabilityHub<object>
  dispose(): Promise<void> | void
}
type Registry = { version: 1; entries: Map<string, Entry> }

const host = globalThis as typeof globalThis & { [registryKey]?: Registry }

function registry(): Registry {
  const existing = host[registryKey]
  if (existing?.version === 1) return existing
  return (host[registryKey] ??= { version: 1, entries: new Map() })
}

export type CoreHandle<C, X extends object> = {
  readonly key: string
  readonly core: C
  readonly hub: CapabilityHub<X>
  /** Drops this location's reference; the last release disposes the core. Idempotent. */
  release(): Promise<void>
}

export type CoreSpec<C, X extends object> = {
  key: string
  /** Canonical project root: the preferred native-capability location. */
  projectDirectory: string
  /** This location's directory and context, registered as a capability provider. */
  directory: string
  ctx: X
  create(hub: CapabilityHub<X>): { core: C; dispose(): Promise<void> | void }
}

export function acquireCore<C, X extends object>(spec: CoreSpec<C, X>): CoreHandle<C, X> {
  const entries = registry().entries
  let entry = entries.get(spec.key)
  if (!entry) {
    const hub = new CapabilityHub<X>(spec.key, spec.projectDirectory)
    // The creating location serves native calls made during construction.
    const unregister = hub.register(spec.directory, spec.ctx)
    try {
      const created = spec.create(hub)
      entry = { key: spec.key, refs: 0, value: created.core, hub, dispose: created.dispose }
    } finally {
      unregister()
    }
    entries.set(spec.key, entry)
  }
  const current = entry
  current.refs++
  const unregister = (current.hub as CapabilityHub<X>).register(spec.directory, spec.ctx)
  let released: Promise<void> | undefined
  return {
    key: spec.key,
    core: current.value as C,
    hub: current.hub as CapabilityHub<X>,
    release: () =>
      (released ??= (async () => {
        unregister()
        if (--current.refs > 0) return
        if (entries.get(current.key) === current) entries.delete(current.key)
        await current.dispose()
      })()),
  }
}

/** Diagnostic: live core keys, reference counts and live capability providers. */
export function coreSnapshot() {
  return [...registry().entries.values()].map((entry) => ({
    key: entry.key,
    refs: entry.refs,
    providers: entry.hub.size,
  }))
}
