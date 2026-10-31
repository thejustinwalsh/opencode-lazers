import { expect, test } from "bun:test"
import { withResources } from "./resources.ts"
import { CaptureResources } from "./capture.ts"

test("failed inference and partially constructed feeds dispose every owned tensor", async () => {
  const released: string[] = []
  await expect(
    withResources(async (own) => {
      own({
        dispose: () => {
          released.push("input")
        },
      })
      own({
        dispose: () => {
          released.push("output")
          throw new Error("cleanup")
        },
      })
      throw new Error("session.run failed")
    }),
  ).rejects.toThrow("cleanup failed")
  expect(released).toEqual(["output", "input"])
  released.length = 0
  await expect(
    withResources(async (own) => {
      own({
        dispose: () => {
          released.push("constructed")
        },
      })
      throw new Error("next tensor construction failed")
    }),
  ).rejects.toThrow("construction failed")
  expect(released).toEqual(["constructed"])
})

test("late microphone cleanup belongs to the cancelled capture, never to a newer recording", async () => {
  const released: string[] = []
  const resources = (name: string) => {
    const value = new CaptureResources()
    value.stream = {
      getTracks: () => [{ stop: () => released.push(`${name} track`) }],
    } as unknown as MediaStream
    value.meter = {
      close: async () => {
        released.push(`${name} context`)
      },
    } as unknown as AudioContext
    return value
  }
  const old = resources("old")
  old.release()
  const current = resources("current")
  old.release()
  expect(released).toEqual(["old track", "old context"])
  expect(current.stream).toBeDefined()
  current.release()
  expect(released).toEqual(["old track", "old context", "current track", "current context"])
})
