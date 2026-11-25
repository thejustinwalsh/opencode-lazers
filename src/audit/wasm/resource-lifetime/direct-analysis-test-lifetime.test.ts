import { afterEach, expect, test } from "bun:test"
import {
  closeOutstandingDirectAnalysisTestLifetimes,
  createDirectAnalysisTestRegistrar,
} from "./direct-analysis-test-lifetime.ts"

afterEach(closeOutstandingDirectAnalysisTestLifetimes)

type TestCallback = () => void | Promise<unknown>

function registerCallback(callback: TestCallback): TestCallback {
  let registeredCallback: TestCallback | undefined
  const register = createDirectAnalysisTestRegistrar((_label, wrapped) => {
    registeredCallback = wrapped
  })
  register("registrar completion", callback)
  if (!registeredCallback) throw new Error("registrar did not register the test callback")
  return registeredCallback
}

test("registrar preserves a synchronous callback throw", async () => {
  const failure = new Error("synchronous test failure")
  const callback = registerCallback(() => {
    throw failure
  })

  await expect(callback()).rejects.toBe(failure)
})

test("registrar preserves an asynchronous callback rejection", async () => {
  const failure = new Error("asynchronous test failure")
  const callback = registerCallback(async () => {
    await Promise.resolve()
    throw failure
  })

  await expect(callback()).rejects.toBe(failure)
})

test("registrar resolves a successful callback with its value", async () => {
  const value = { completed: true }
  const callback = registerCallback(async () => value)

  await expect(callback()).resolves.toBe(value)
})
