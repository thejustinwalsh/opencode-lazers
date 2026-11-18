import { expect, test } from "bun:test"
import { withReadDeadline } from "./read-deadline.ts"

test("a read that never settles fails at the deadline and is aborted", async () => {
  let aborted = false
  const parent = new AbortController()
  const result = withReadDeadline(
    parent.signal,
    (signal) =>
      new Promise<never>(() => {
        signal.addEventListener("abort", () => {
          aborted = true
        })
      }),
    5,
  )
  await expect(result).rejects.toThrow("Timed out waiting for the LAZERS service")
  expect(aborted).toBe(true)
  expect(parent.signal.aborted).toBe(false)
})

test("a read that answers in time returns its value", async () => {
  const parent = new AbortController()
  await expect(withReadDeadline(parent.signal, async () => 7, 50)).resolves.toBe(7)
})

test("aborting the parent aborts the read", async () => {
  const parent = new AbortController()
  let seen: AbortSignal | undefined
  const result = withReadDeadline(
    parent.signal,
    (signal) => {
      seen = signal
      return new Promise<number>(() => {})
    },
    50,
  )
  parent.abort()
  expect(seen?.aborted).toBe(true)
  await expect(result).rejects.toThrow()
})
