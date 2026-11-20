import { afterEach, expect, test } from "bun:test"
import {
  forgetVerificationActivity,
  startVerificationActivity,
  verificationActivity,
} from "./verification-activities.ts"

const keys: { key: string; identity: string }[] = []
afterEach(() => {
  for (const { key, identity } of keys.splice(0)) forgetVerificationActivity(key, identity)
})

function start<T>(run: () => Promise<T>, summarize?: (result: T) => unknown) {
  const key = `test-${crypto.randomUUID()}`
  keys.push({ key, identity: "same" })
  return startVerificationActivity<T>({
    databasePath: "/nonexistent/tasks.sqlite",
    key,
    identity: "same",
    owner: "owner",
    metadata: {},
    run,
    ...(summarize ? { summarize } : {}),
  }).activity
}

test("a completed activity keeps its summary, not the result", async () => {
  const weak = new WeakRef({ log: "x".repeat(1_000_000) })
  const activity = start(
    async () => weak.deref()!,
    (result) => ({ bytes: result.log.length }),
  )
  await activity.settled
  expect(activity.state).toBe("completed")
  expect(activity.summary).toEqual({ bytes: 1_000_000 })
  expect(await activity.promise).toBeUndefined()
  expect(Object.keys(activity)).not.toContain("result")
  // Nothing the activity holds reaches the result object.
  expect(
    JSON.stringify(activity, (_key, value) => (typeof value === "object" ? value : value)),
  ).not.toContain("xxxx")
})

test("a failed activity keeps its error and settles its promise by rejection", async () => {
  const activity = start(async () => {
    throw new Error("boom")
  })
  await activity.settled
  expect(activity.state).toBe("failed")
  await expect(activity.promise).rejects.toThrow("boom")
  expect(verificationActivity(activity.key)).toBe(activity)
})
