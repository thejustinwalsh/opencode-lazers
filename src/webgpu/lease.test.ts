import { expect, test } from "bun:test"
import { ModelLease } from "./lease.ts"

test("cache cleanup and retirement exclude new allocations until asynchronous work drains", async () => {
  const draining = Promise.withResolvers<void>()
  const lease = new ModelLease(() => draining.promise)
  const token = lease.acquire(1)
  expect(() => lease.assert(2, token)).toThrow()
  await lease.lost(2)
  lease.assert(1, token)
  const release = lease.release(1, token)
  expect(() => lease.assert(1, token)).toThrow()
  expect(() => lease.acquire(2)).toThrow()
  await expect(lease.clear(async () => {})).rejects.toThrow()
  draining.resolve()
  await release
  const clearing = Promise.withResolvers<void>()
  const cleanup = lease.clear(() => clearing.promise)
  expect(lease.occupied()).toBe(true)
  expect(() => lease.acquire(2)).toThrow()
  clearing.resolve()
  await cleanup
  expect(lease.acquire(2)).not.toBe(token)
})

test("a failed retirement retains ownership; a failed cleanup releases the maintenance barrier", async () => {
  let fail = true
  const lease = new ModelLease(async () => {
    if (fail) throw new Error("drain failed")
  })
  const token = lease.acquire(1)
  await expect(lease.lost(1)).rejects.toThrow("drain failed")
  expect(() => lease.acquire(2)).toThrow()
  lease.assert(1, token)
  fail = false
  await lease.release(1, token)
  await expect(
    lease.clear(async () => {
      throw new Error("disk failed")
    }),
  ).rejects.toThrow("disk failed")
  expect(lease.occupied()).toBe(false)
  expect(lease.acquire(2)).toBeString()
})
