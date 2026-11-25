import { expect, test } from "bun:test"
import { createSharedMemoryTracker } from "./shared-memory-tracker.ts"

test("shared-memory diagnostics separate live references from pending finalizers", () => {
  const tracker = createSharedMemoryTracker()
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })

  tracker.track(memory)

  expect(tracker.snapshot()).toEqual({ live: 1, pendingFinalizers: 1 })
})
