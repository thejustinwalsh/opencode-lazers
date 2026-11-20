import type { Database } from "bun:sqlite"
import { databaseChanges } from "../../database-events.ts"
import { TaskRepository } from "../../storage.ts"
import { backfillPage, backfillState } from "./backfill.ts"
import { drainTaskSchedule, hasScheduleWork, nextRetryAt, retryParked } from "./drain.ts"

/**
 * The project core's owner of the projection: pages the backfill until the project is ready, and
 * drains whatever stale plugin copies queued (their writes fire the triggers but not the drain).
 * Idle, it holds a table-change subscription and no timer.
 */
/** A project with tasks whose list is not indexed yet. */
function nextUnindexed(db: Database): string | undefined {
  return db
    .query<{ project_directory: string }, []>(
      `SELECT t.project_directory FROM tasks t WHERE NOT EXISTS (
         SELECT 1 FROM task_schedule_state s WHERE s.project_directory=t.project_directory AND s.ready=1
       ) LIMIT 1`,
    )
    .get()?.project_directory
}

export class TaskScheduleOwner {
  private closed = false
  /** Look for a project that still needs its backfill; set at start and when a task is added. */
  private discover = true
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
      if (tables.has("tasks")) this.discover = true
      if (tables.has("task_schedule_dirty") || tables.has("tasks")) this.settle()
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
          // Every project in the database, not only this repository's: the triggers are
          // database-wide, so the backfill is too. Each project has its own `ready`.
          while (this.discover && !this.closed) {
            const project = this.repository.read((db) => nextUnindexed(db))
            if (!project) {
              this.discover = false
              break
            }
            const page = await this.repository.retryBusy(() =>
              this.repository.atomic((db) => backfillPage(db, project)),
            )
            if (!page.done) await Bun.sleep(0)
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

type Held = { owner: TaskScheduleOwner; repository: TaskRepository; refs: number }
const registryKey = Symbol.for("lazers.task-schedule.owners.v1")
const host = globalThis as typeof globalThis & { [registryKey]?: Map<string, Held> }
const held = () => (host[registryKey] ??= new Map())

/**
 * The one schedule owner of a database in this process, shared by every project core that loads
 * it (like the reader pool). It backfills every project found in `tasks`; the last release stops
 * it and closes its own connection. Settle it to wait for the indexing.
 */
export function acquireScheduleOwner(path: string, projectDirectory: string) {
  let entry = held().get(path)
  if (!entry) {
    const repository = new TaskRepository(path, projectDirectory)
    const owner = new TaskScheduleOwner(repository)
    entry = { owner, repository, refs: 0 }
    held().set(path, entry)
    owner.start()
  }
  entry.refs++
  const taken = entry
  let released = false
  return {
    owner: taken.owner,
    release() {
      if (released) return
      released = true
      if (--taken.refs > 0) return
      held().delete(path)
      taken.owner.close()
      taken.repository.close()
    },
  }
}
