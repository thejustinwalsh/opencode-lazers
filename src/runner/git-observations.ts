import { commitIsAncestor, gitAsync } from "./artifacts.ts"

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }

/** Thrown inside a synchronous transaction when a Git observation is not yet known. */
export class ObservationRequired extends Error {
  constructor(
    readonly key: string,
    readonly load: () => Promise<unknown>,
  ) {
    super(`Git observation required: ${key}`)
  }
}

/**
 * Observations of Git (or the filesystem) for code that must run inside one
 * synchronous SQLite transaction. The transaction body reads observations with
 * `read`; a missing one aborts the body, `run` awaits it outside the
 * transaction, then re-runs the body. Observations are memoized for the life
 * of one `run`, so each retry sees the same snapshot and a failed observation
 * rethrows its original error inside the body, exactly where a blocking call
 * used to throw.
 */
export class GitObservations {
  private readonly memo = new Map<string, Outcome>()

  read<T>(key: string, load: () => Promise<T>): T {
    const hit = this.memo.get(key)
    if (!hit) throw new ObservationRequired(key, load)
    if (hit.ok) return hit.value as T
    throw hit.error
  }

  git(directory: string, args: string[]): string {
    return this.read(`git\0${directory}\0${args.join("\0")}`, () => gitAsync(directory, args))
  }

  isAncestor(directory: string, ancestor: string, descendant: string): boolean {
    return this.read(`ancestor\0${directory}\0${ancestor}\0${descendant}`, () =>
      commitIsAncestor(directory, ancestor, descendant),
    )
  }

  /** Run a synchronous body, resolving observations it requests between attempts. */
  async run<T>(body: () => T, guard?: () => void): Promise<T> {
    for (let attempt = 0; attempt < 256; attempt++) {
      try {
        return body()
      } catch (error) {
        if (!(error instanceof ObservationRequired)) throw error
        guard?.()
        try {
          this.memo.set(error.key, { ok: true, value: await error.load() })
        } catch (failure) {
          this.memo.set(error.key, { ok: false, error: failure })
        }
        // The owner may have stopped (and closed its store) while Git ran.
        guard?.()
      }
    }
    throw new Error("Too many Git observations requested by one transaction")
  }
}
