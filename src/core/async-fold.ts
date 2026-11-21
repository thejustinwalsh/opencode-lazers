/**
 * The shared parts of an asynchronous queue fold (a fold that awaits a host read between its
 * queue read and its write: `host-sessions/fold.ts`, `transcript-meta/fold.ts`): the coalescing
 * drain loop and the per-process lease of one fold per (database, project).
 */

/** One queued entry: its ref and the failed attempts so far (the backoff). */
export type QueueEntry = { ref: string; attempts: number }

/**
 * A drain function that reads due entries until none is left, one run at a time. A call during a
 * run marks it to look again; the run clears itself in the same turn as its last look, so a call
 * never gets a run that has already stopped looking. After each pass the retry timer is scheduled
 * for the earliest parked entry.
 */
export function coalescedDrain(fold: {
  closed(): boolean
  due(): QueueEntry[]
  read(entry: QueueEntry): Promise<void>
  schedule(): void
  onError?: ((error: unknown) => void) | undefined
}): { drain(): Promise<void>; running(): boolean } {
  let again = false
  let current: Promise<void> | undefined
  const pass = async () => {
    try {
      for (;;) {
        const batch = fold.due()
        if (!batch.length || fold.closed()) return
        for (const entry of batch) {
          if (fold.closed()) return
          await fold.read(entry)
        }
      }
    } catch (error) {
      // The database is busy or failing: the work stays queued for the next change or retry.
      fold.onError?.(error)
    }
  }
  const drain = (): Promise<void> => {
    if (fold.closed()) return Promise.resolve()
    again = true
    if (current) return current
    let run: Promise<void> | undefined = undefined
    run = (async () => {
      await Promise.resolve()
      try {
        while (again && !fold.closed()) {
          again = false
          await pass()
          if (!fold.closed()) fold.schedule()
        }
      } finally {
        if (current === run) current = undefined
      }
    })()
    current = run
    return run
  }
  return { drain, running: () => current !== undefined }
}

type Held<F> = { fold: F; stop(): void; refs: number }

/**
 * The one fold `id` names in this process under `registry` (a `Symbol.for` key, so every plugin
 * copy shares it): created on the first lease, stopped by the last release.
 */
export function leaseFold<F>(
  registry: symbol,
  id: string,
  create: () => { fold: F; stop(): void },
): { readonly fold: F; release(): void } {
  const host = globalThis as typeof globalThis & Record<symbol, Map<string, Held<F>> | undefined>
  const held = (host[registry] ??= new Map())
  let entry = held.get(id)
  if (!entry) {
    entry = { ...create(), refs: 0 }
    held.set(id, entry)
  }
  entry.refs++
  const taken = entry
  let released = false
  return {
    fold: taken.fold,
    release() {
      if (released) return
      released = true
      if (--taken.refs > 0) return
      held.delete(id)
      taken.stop()
    },
  }
}
