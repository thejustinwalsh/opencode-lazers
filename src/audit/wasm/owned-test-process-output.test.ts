import { expect, test } from "bun:test"
import { drainAfterTermination, withTimeout } from "./owned-test-process-output.ts"

test("a never-settling output cancellation fails within bounded cleanup without unhandled rejection", async () => {
  const unhandled: unknown[] = []
  const recordUnhandled = (reason: unknown) => unhandled.push(reason)
  let rejectReader!: (error: Error) => void
  const pendingReader = new Promise<void>((_resolve, reject) => {
    rejectReader = reject
  })
  const neverCancel = new Promise<void>(() => {})
  let cancellationCalls = 0
  let failure: unknown
  process.on("unhandledRejection", recordUnhandled)
  const startedAt = performance.now()

  try {
    await withTimeout(
      drainAfterTermination(
        [
          {
            done: pendingReader,
            cancel: () => {
              cancellationCalls++
              return neverCancel
            },
          },
        ],
        { drainMs: 10, cancelMs: 10, settleMs: 10 },
      ),
      1_000,
      "Output cleanup regression watchdog expired",
    )
  } catch (error) {
    failure = error
  } finally {
    rejectReader(new Error("late output reader rejection"))
    await Bun.sleep(0)
    process.off("unhandledRejection", recordUnhandled)
  }

  expect(failure).toBeInstanceOf(AggregateError)
  const diagnostics =
    failure instanceof AggregateError ? failure.errors.map(String).join("\n") : String(failure)
  expect(diagnostics).toContain("stream cancellation did not settle")
  expect(diagnostics).toContain("output readers did not settle after cancellation")
  expect(cancellationCalls).toBe(1)
  expect(performance.now() - startedAt).toBeLessThan(1_000)
  expect(unhandled).toEqual([])
})
