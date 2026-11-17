import { realpathSync } from "node:fs"
import { resolve } from "node:path"

function canonical(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

type Provider<C> = { id: symbol; directory: string; ctx: C }

export class NoCapabilityProviderError extends Error {
  constructor(readonly key: string) {
    super("No live LAZERS location can provide native capabilities")
  }
}

/**
 * Live OpenCode locations that can serve native calls (session, worktree, agent,
 * permission). The core never captures one location's context: `context` resolves
 * the preferred live provider on every property read, so a disposed location is
 * replaced transparently by the next one.
 */
export class CapabilityHub<C extends object> {
  private providers: Provider<C>[] = []
  private lastPreferred: symbol | undefined
  failovers = 0
  /** Delegates every read to the preferred live provider at call time. */
  readonly context: C

  constructor(
    readonly key: string,
    private readonly preferredDirectory: string,
  ) {
    this.context = this.delegate(() => this.preferred().ctx)
  }

  get size() {
    return this.providers.length
  }

  directories() {
    return this.providers.map((provider) => provider.directory)
  }

  register(directory: string, ctx: C) {
    const provider: Provider<C> = { id: Symbol(directory), directory: canonical(directory), ctx }
    this.providers.push(provider)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      this.providers = this.providers.filter((candidate) => candidate !== provider)
    }
  }

  /** Canonical project root location when live; otherwise the earliest live location. */
  preferred(): Provider<C> {
    const root = canonical(this.preferredDirectory)
    const provider =
      this.providers.find((candidate) => candidate.directory === root) ?? this.providers[0]
    if (!provider) throw new NoCapabilityProviderError(this.key)
    if (this.lastPreferred !== undefined && this.lastPreferred !== provider.id) this.failovers++
    this.lastPreferred = provider.id
    return provider
  }

  /** Context that must run in one location: that location when live, else the preferred one. */
  contextAt(directory: string): C {
    const exact = canonical(directory)
    return this.delegate(
      () =>
        (this.providers.find((candidate) => candidate.directory === exact) ?? this.preferred()).ctx,
    )
  }

  private delegate(pick: () => C): C {
    return new Proxy({} as C, {
      get: (_, property) => {
        const owner = pick()
        const value = Reflect.get(owner, property)
        return typeof value === "function" ? value.bind(owner) : value
      },
      has: (_, property) => Reflect.has(pick(), property),
    })
  }
}
