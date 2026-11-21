import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { SchedulerCoordinator, type SchedulerProjectStatus } from "./scheduler-coordinator.ts"
import { ensureSchedulerStatusSchema, mirrorSchedulerStatus } from "./scheduler-status.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** A clock the test advances: timers fire only when `tick` says. */
function manualClock() {
  let now = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  let next = 1
  return {
    now: () => now,
    set(run: () => void, delay: number) {
      const id = next++
      timers.set(id, { at: now + delay, run })
      return id
    },
    clear(handle: unknown) {
      timers.delete(handle as number)
    },
    tick(ms: number) {
      now += ms
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id)
          timer.run()
        }
    },
  }
}

test("watch: a listener hears the status now and on every change, once per change", async () => {
  const clock = manualClock()
  const coordinator = new SchedulerCoordinator(clock)
  const heard: SchedulerProjectStatus[] = []
  const off = coordinator.watch("p", (status) => heard.push(status))
  let release!: () => void
  const registration = coordinator.register("p", {
    intervalMs: 1000,
    run: () => new Promise<void>((resolve) => (release = resolve)),
  })
  clock.tick(0)
  await Bun.sleep(0)
  await Bun.sleep(0)
  release()
  await Bun.sleep(0)
  await Bun.sleep(0)
  await registration.dispose()
  off()
  expect(heard.map((status) => status.status)).toEqual([
    "absent",
    "scheduled",
    "draining",
    "scheduled",
    "absent",
  ])
})

test("mirror: the project's row holds the latest status; stop writes the last one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-scheduler-status-"))
  const repository = new TaskRepository(join(directory, "tasks.sqlite"), directory)
  cleanups.push(() => {
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  })
  ensureSchedulerStatusSchema(repository)
  const clock = manualClock()
  const coordinator = new SchedulerCoordinator(clock)
  const mirror = mirrorSchedulerStatus(coordinator, "p", repository)
  const registration = coordinator.register("p", { intervalMs: 1000, run: () => {} })
  const row = () =>
    repository.read((db) =>
      db.query("SELECT project_directory,status,participants FROM scheduler_project_status").all(),
    )
  await Bun.sleep(10)
  expect(row()).toEqual([{ project_directory: directory, status: "scheduled", participants: 1 }])
  await registration.dispose()
  await mirror.stop()
  expect(row()).toEqual([{ project_directory: directory, status: "absent", participants: 0 }])
})
