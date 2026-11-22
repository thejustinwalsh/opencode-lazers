import type { TaskRepository } from "../storage.ts"

/**
 * The parking and retry timer of an asynchronous queue drain (a fold that awaits a host read or
 * a provider between its read and its write, so it cannot drain inside the writer's transaction).
 * The queue table has the shared shape (`src/projections/queue.ts`); one queue serves every
 * project, so each owner reads only its own ref range.
 *
 * ```
 * refresh throws ─► park: attempts+1, error, next_at = now + backoff (1 s doubling to 5 min)
 * drain done ─► one timer at the earliest next_at in the range ─► drain again
 * ```
 */
const BACKOFF_FIRST_MS = 1000
const BACKOFF_CEILING_MS = 5 * 60_000

/** Park a failed entry with its error and a backoff; `claim` narrows to an entry still claimed. */
export function parkQueueEntry(
  repository: TaskRepository,
  table: string,
  entry: { ref: string; attempts: number },
  error: unknown,
  now: number,
  claim = "",
) {
  const message = error instanceof Error ? error.message : String(error)
  repository.atomic((db) =>
    db
      .query(`UPDATE ${table} SET attempts=?,error=?,next_at=? WHERE ref=? ${claim}`)
      .run(
        entry.attempts + 1,
        message.slice(0, 500),
        now + Math.min(BACKOFF_FIRST_MS * 2 ** entry.attempts, BACKOFF_CEILING_MS),
        entry.ref,
      ),
  )
}

/** One timer, held only while an entry of the range waits; it fires at the earliest. */
export class QueueRetryTimer {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly repository: TaskRepository,
    private readonly table: string,
    private readonly range: readonly [string, string],
    private readonly now: () => number,
    private readonly fire: () => void,
  ) {}

  get pending() {
    return this.timer !== undefined
  }

  schedule() {
    this.clear()
    const [low, high] = this.range
    let at: number | null | undefined
    try {
      at = this.repository.read(
        (db) =>
          db
            .query<{ at: number | null }, [string, string, number]>(
              `SELECT MIN(next_at) AS at FROM ${this.table} WHERE ref>=? AND ref<? AND next_at>?`,
            )
            .get(low, high, this.now())?.at,
      )
    } catch {
      return
    }
    if (at === null || at === undefined) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.fire()
      },
      Math.max(0, at - this.now()),
    )
    this.timer.unref?.()
  }

  clear() {
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
