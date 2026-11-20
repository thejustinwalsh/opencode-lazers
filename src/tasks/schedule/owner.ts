import { databaseChanges } from "../../database-events.ts"
import type { TaskRepository } from "../../storage.ts"
import { backfillPage, backfillState } from "./backfill.ts"
import { drainTaskSchedule, hasScheduleWork } from "./drain.ts"

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
        for (;;) {
          const page = await this.repository.retryBusy(() =>
            this.repository.atomic((db) => backfillPage(db, this.repository.projectDirectory)),
          )
          if (page.done || this.closed) break
          await Bun.sleep(0)
        }
        while (!this.closed) {
          const result = await this.repository.retryBusy(() =>
            this.repository.atomic((db) =>
              hasScheduleWork(db)
                ? drainTaskSchedule(db)
                : { handled: 0, remaining: 0, failed: [] },
            ),
          )
          // A failing entry stays queued and is retried by the next write's drain.
          if (!result.remaining || result.failed.length) break
          await Bun.sleep(0)
        }
      }
    })().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  close(): void {
    this.closed = true
    this.unsubscribe?.()
  }
}
