import { afterEach, expect, test as bunTest } from "bun:test"
import { ThreadPool } from "../../fallow-wasi.ts"
import { DirectAnalysisScopeClosedError, directAnalysisScopeFor } from "./direct-analysis-scope.ts"
import {
  closeOutstandingDirectAnalysisTestLifetimes,
  createDirectAnalysisTestRegistrar,
} from "./direct-analysis-test-lifetime.ts"
import { disposeFixture, makeFixture, runOp } from "../test-support.ts"

afterEach(closeOutstandingDirectAnalysisTestLifetimes)
const test = createDirectAnalysisTestRegistrar(bunTest)

test("fixture teardown drains gated work and cancels later analyses", async () => {
  const fixture = makeFixture()
  const scope = directAnalysisScopeFor(fixture)
  const pool = new ThreadPool()
  let releaseGate!: () => void
  let markStarted!: () => void
  let started = false
  let analysesStarted = 0
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  const didStart = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const unhandled: unknown[] = []
  const recordUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on("unhandledRejection", recordUnhandled)

  try {
    const active = scope.run(async () => {
      analysesStarted++
      pool.take()
      started = true
      markStarted()
      try {
        await gate
      } finally {
        await pool.terminateAll()
      }
    })
    void active.catch(() => {})
    await didStart

    const queued = runOp("health", fixture, {}, { onInstance: () => analysesStarted++ })
    const teardown = disposeFixture(fixture)
    let teardownFinished = false
    void teardown.then(() => {
      teardownFinished = true
    })

    // A timed-out test body can continue after teardown starts and attempt another analysis.
    void runOp("health", fixture, {}, { onInstance: () => analysesStarted++ })
    await Promise.resolve()
    expect(teardownFinished).toBe(false)
    expect(pool.liveCount).toBe(1)
    expect(started).toBe(true)

    releaseGate()
    await active
    await teardown
    await expect(queued).rejects.toBeInstanceOf(DirectAnalysisScopeClosedError)
    await Bun.sleep(0)

    expect(analysesStarted).toBe(1)
    expect(scope.metrics.cancelled).toBe(2)
    expect(scope.pendingCount).toBe(0)
    expect(pool.liveCount).toBe(0)
    expect(unhandled).toEqual([])

    const nextFixture = makeFixture()
    try {
      const result = await runOp("health", nextFixture)
      expect(result.report).toBeTruthy()
    } finally {
      await disposeFixture(nextFixture)
    }
  } finally {
    releaseGate()
    process.off("unhandledRejection", recordUnhandled)
    await disposeFixture(fixture)
  }
})
