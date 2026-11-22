import { expect, test } from "bun:test"
import { makeFixture, taskID } from "../../test/trajectory/fixture.ts"
import { storeSessions } from "../../test/trajectory/stored-sessions.ts"
import { lz137ValuationProvider } from "../../test/trajectory-panel/lz137-market-fixture.ts"
import { computeTaskEffort } from "./effort-compute.ts"
import { startTaskEffortFold } from "./effort-store.ts"
import { awaitTaskEffort } from "./effort-wait.ts"

const provider = lz137ValuationProvider({ withStrictOpenCodePrice: true })

test("a reader waits for a task's first effort row: stored when it is written in time", async () => {
  const fixture = makeFixture()
  try {
    storeSessions(fixture)
    const path = fixture.repository.path
    // No effort fold in this process: nothing will write it for this read.
    expect(await awaitTaskEffort(path, fixture.directory, taskID, 50)).toBe("not-computed")
    const lease = startTaskEffortFold(
      path,
      fixture.directory,
      (task, signal) =>
        computeTaskEffort(path, fixture.directory, "project", task, provider, signal),
      { spacingMs: 0 },
    )
    try {
      await lease.fold.settle()
      fixture.repository.atomic((db) => db.exec("DELETE FROM trajectory_task_effort"))
      const started = performance.now()
      expect(await awaitTaskEffort(path, fixture.directory, taskID, 5_000)).toBe("stored")
      // It returned at the write, not at the bound.
      expect(performance.now() - started).toBeLessThan(4_000)
      expect(await awaitTaskEffort(path, fixture.directory, taskID, 0)).toBe("stored")
    } finally {
      lease.release()
    }
  } finally {
    fixture.close()
  }
})

test("a reader whose task is still computing after the wait is told so, never a silent null", async () => {
  const fixture = makeFixture()
  try {
    storeSessions(fixture)
    const path = fixture.repository.path
    // A computation that does not finish within the read's wait.
    const lease = startTaskEffortFold(
      path,
      fixture.directory,
      (_task, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        ),
      { spacingMs: 0 },
    )
    try {
      expect(await awaitTaskEffort(path, fixture.directory, taskID, 100)).toBe("computing")
    } finally {
      lease.release()
    }
  } finally {
    fixture.close()
  }
})
