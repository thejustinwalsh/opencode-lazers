import { afterAll, afterEach, beforeAll, expect, test as bunTest } from "bun:test"
import { MAX_FALLOW_THREADS, ThreadPool } from "../../fallow-wasi.ts"
import {
  closeOutstandingDirectAnalysisTestLifetimes,
  createDirectAnalysisTestRegistrar,
} from "./direct-analysis-test-lifetime.ts"
import { directAnalysisScopeFor } from "./direct-analysis-scope.ts"
import { disposeFixture, makeFixture, runOp } from "../test-support.ts"

const test = createDirectAnalysisTestRegistrar(bunTest)
afterEach(closeOutstandingDirectAnalysisTestLifetimes)

const scenario = process.env.DIRECT_ANALYSIS_TIMEOUT_SCENARIO
if (scenario !== "queued" && scenario !== "active")
  throw new Error(`unknown direct-analysis timeout scenario: ${scenario}`)

const unhandled: unknown[] = []
const recordUnhandled = (reason: unknown) => unhandled.push(reason)
process.on("unhandledRejection", recordUnhandled)

const result = {
  lateAssertion: false,
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
  if (scenario === "queued") {
    const blockerScope = directAnalysisScopeFor(result.blocker)
    blockerOperation = blockerScope.run(async () => {
      markBlockStarted()
      await new Promise<void>((resolve) => {
        releaseGate = resolve
      })
    })
    await blockStarted
    await runOp(
      "health",
      result.fixture,
      {},
      {
        onInstance: () => result.analysesStarted++,
      },
    )
  } else {
    const completion = runOp(
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
    await completion
  }

  result.lateAssertion = true
  expect(result.lateAssertion, "late assertion after Bun timeout").toBe(false)
}, 300)

afterEach(async () => {
  closeOutstandingDirectAnalysisTestLifetimes()
  if (scenario === "queued") {
    const fixtureDisposal = disposeFixture(result.fixture)
    releaseGate()
    await Promise.all([fixtureDisposal, blockerOperation])
    await disposeFixture(result.blocker)
  } else {
    const fixtureDisposal = disposeFixture(result.fixture)
    releaseTermination()
    await fixtureDisposal
  }
})

afterAll(async () => {
  expect(result.lateAssertion).toBe(false)
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
