import { databaseChanges } from "../../database-events.ts"
import type { TaskRepository } from "../../storage.ts"
import { backfillPage, backfillState } from "./backfill.ts"
import { drainTaskSchedule, hasScheduleWork, nextRetryAt, retryParked } from "./drain.ts"

/**
 * The project core's owner of the projection: pages the backfill until the project is ready, and
 * drains whatever stale plugin copies queued (their writes fire the triggers but not the drain).
 * Idle, it holds a table-change subscription and no timer.
 */
export class TaskScheduleOwner {
  private closed = false
  private running: Promise<void> | undefined
  private again = false
  private unsubscribe: (() => void) | undefined
  private retry: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly repository: TaskRepository) {}

  ready(): boolean {
    return this.repository.read(
      (db) => backfillState(db, this.repository.projectDirectory).ready === 1,
    )
  }

  start(): void {
    this.unsubscribe = databaseChanges.subscribeTables(this.repository.path, (tables) => {
      if (tables.has("task_schedule_dirty")) this.settle()
    })
    this.settle()
  }

  /** Run until the backfill is complete and the queue is empty; coalesces concurrent calls. */
  settle(): Promise<void> {
    this.again = true
    this.running ??= (async () => {
      while (this.again && !this.closed) {
        this.again = false
        try {
          for (;;) {
            const page = await this.repository.retryBusy(() =>
              this.repository.atomic((db) => backfillPage(db, this.repository.projectDirectory)),
            )
            // The state and the counters are WITHOUT ROWID tables: the update hook never names them.
            databaseChanges.touch(this.repository.path, [
              "task_schedule_state",
              "task_schedule_counts",
            ])
            if (page.done || this.closed) break
            await Bun.sleep(0)
          }
          while (!this.closed) {
            const result = await this.repository.retryBusy(() =>
              this.repository.atomic((db) => {
                retryParked(db)
                return hasScheduleWork(db)
                  ? drainTaskSchedule(db)
                  : { handled: 0, remaining: 0, failed: [] }
              }),
            )
            if (!result.remaining) break
            await Bun.sleep(0)
          }
        } catch {
          // A busy or failing database leaves the work queued; the next change or retry resumes it.
        }
        try {
          this.scheduleRetry()
        } catch {
          // Closed while settling.
        }
      }
    })().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  /** One timer, only while an entry is parked; it fires at the earliest backoff. */
  private scheduleRetry() {
    if (this.retry || this.closed) return
    const at = this.repository.read((db) => nextRetryAt(db))
    if (at === undefined) return
    this.retry = setTimeout(
      () => {
        this.retry = undefined
        void this.settle()
      },
      Math.max(0, at - Date.now()),
    )
  }

  close(): void {
    this.closed = true
    if (this.retry) clearTimeout(this.retry)
    this.unsubscribe?.()
  }
}
