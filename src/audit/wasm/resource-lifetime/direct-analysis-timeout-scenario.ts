import { afterAll, afterEach, beforeAll, expect, test as bunTest } from "bun:test"
import { MAX_FALLOW_THREADS, ThreadPool } from "../../fallow-wasi.ts"
import { runDirectFallowModule } from "./direct-analysis.ts"
import {
  closeOutstandingDirectAnalysisTestLifetimes,
  createDirectAnalysisTestRegistrar,
} from "./direct-analysis-test-lifetime.ts"
import { directAnalysisScopeFor } from "./direct-analysis-scope.ts"
import { disposeFixture, makeFixture, runOp, wasmModule } from "../test-support.ts"

const test = createDirectAnalysisTestRegistrar(bunTest)

const scenario = process.env.DIRECT_ANALYSIS_TIMEOUT_SCENARIO
if (scenario !== "queued" && scenario !== "active")
  throw new Error(`unknown direct-analysis timeout scenario: ${scenario}`)

const unhandled: unknown[] = []
const recordUnhandled = (reason: unknown) => unhandled.push(reason)
process.on("unhandledRejection", recordUnhandled)

const result = {
  lateAssertion: false,
  secondAttempted: false,
  directAttempted: false,
  directExpired: false,
  analysesStarted: 0,
  pool: undefined as ThreadPool | undefined,
  fixture: "",
  blocker: "",
  nextFixture: "",
}

let releaseGate!: () => void
let markBlockStarted!: () => void
let markTerminationEntered!: () => void
let blockStarted!: Promise<void>
let terminationEntered!: Promise<void>
let blockerOperation: Promise<void> | undefined
let releaseTermination!: () => void

beforeAll(() => {
  const extra = Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [
      `src/extra-${index}.ts`,
      `export const extra${index} = ${index}\n`,
    ]),
  )
  result.fixture = makeFixture(extra)
  if (scenario === "queued") {
    result.blocker = makeFixture()
    blockStarted = new Promise<void>((resolve) => {
      markBlockStarted = resolve
    })
  } else {
    const pool = new ThreadPool()
    pool.take()
    result.pool = pool
    const originalTerminateAll = pool.terminateAll.bind(pool)
    terminationEntered = new Promise<void>((resolve) => {
      markTerminationEntered = resolve
    })
    pool.terminateAll = async () => {
      markTerminationEntered()
      await new Promise<void>((resolve) => {
        releaseTermination = resolve
      })
      await originalTerminateAll()
    }
  }
})

test(`${scenario} direct analysis body times out at its runOp boundary`, async () => {
  let completion: Promise<unknown>
  if (scenario === "queued") {
    const blockerScope = directAnalysisScopeFor(result.blocker)
    blockerOperation = blockerScope.run(async () => {
      markBlockStarted()
      await new Promise<void>((resolve) => {
        releaseGate = resolve
      })
    })
    await blockStarted
    completion = runOp(
      "health",
      result.fixture,
      {},
      {
        onInstance: () => result.analysesStarted++,
      },
    )
  } else {
    completion = runOp(
      "deadCode",
      result.fixture,
      {},
      {
        maxThreads: MAX_FALLOW_THREADS,
        threadPool: result.pool,
        onInstance: () => result.analysesStarted++,
      },
      "threads",
    )
    await terminationEntered
  }

  try {
    await completion
  } catch {
    // The owning test lifetime expires at the Bun timeout while analysis is pending.
  }
  result.secondAttempted = true
  try {
    await runOp("health", result.fixture, {}, { onInstance: () => result.analysesStarted++ })
  } catch {
    // A late body continuation must be rejected before it can enqueue more work.
  }
  result.directAttempted = true
  try {
    await runDirectFallowModule(
      wasmModule,
      { op: "health", root: result.fixture },
      {
        onInstance: () => result.analysesStarted++,
      },
    )
  } catch (error) {
    result.directExpired = error instanceof Error && error.name === "DirectAnalysisTestExpiredError"
    if (!result.directExpired) throw error
    return
  }

  result.lateAssertion = true
  expect(result.lateAssertion, "late assertion after Bun timeout").toBe(false)
}, 300)

afterEach(async () => {
  const lifetimeDrain = closeOutstandingDirectAnalysisTestLifetimes()
  if (scenario === "queued") {
    releaseGate()
    await lifetimeDrain
    await Promise.all([disposeFixture(result.fixture), blockerOperation])
    await disposeFixture(result.blocker)
  } else {
    releaseTermination()
    await lifetimeDrain
    await disposeFixture(result.fixture)
  }
})

afterAll(async () => {
  expect(result.lateAssertion).toBe(false)
  expect(result.secondAttempted).toBe(true)
  expect(result.directAttempted).toBe(true)
  expect(result.directExpired).toBe(true)
  expect(result.analysesStarted).toBe(scenario === "queued" ? 0 : 1)
  expect(result.pool?.liveCount ?? 0).toBe(0)
  expect(directAnalysisScopeFor(result.fixture).metrics.pendingHelpers).toBe(0)
  await Bun.sleep(0)
  expect(unhandled).toEqual([])

  result.nextFixture = makeFixture()
  try {
    const next = await runOp("health", result.nextFixture)
    expect(next.report).toBeTruthy()
  } finally {
    await disposeFixture(result.nextFixture)
  }
  process.off("unhandledRejection", recordUnhandled)
})
