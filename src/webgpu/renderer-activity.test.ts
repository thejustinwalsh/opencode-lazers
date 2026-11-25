import { expect, test } from "bun:test"
import { RendererActivity } from "./renderer-activity.ts"

function renderer(initial = true) {
  const changes: boolean[] = []
  return {
    destroyed: false,
    throttled: initial,
    changes,
    isDestroyed() {
      return this.destroyed
    },
    getBackgroundThrottling() {
      return this.throttled
    },
    setBackgroundThrottling(value: boolean) {
      this.throttled = value
      changes.push(value)
    },
  }
}

test("inference unthrottles hidden renderers only while requests are active and restores host settings", () => {
  const hidden = renderer()
  const alreadyUnthrottled = renderer(false)
  const activity = new RendererActivity(() => [hidden, alreadyUnthrottled])
  activity.set(false)
  expect(hidden.changes).toEqual([])
  activity.set(true)
  activity.set(true)
  expect(hidden.throttled).toBe(false)
  activity.set(false)
  expect(hidden.changes).toEqual([false, true])
  expect(alreadyUnthrottled.changes).toEqual([false, false])
})

test("new windows join an active inference period and destroyed windows are not accessed during cleanup", () => {
  const first = renderer()
  const activity = new RendererActivity(() => [first])
  activity.set(true)
  const second = renderer()
  activity.watch(second)
  expect(second.throttled).toBe(false)
  first.destroyed = true
  activity.set(false)
  expect(first.changes).toEqual([false])
  expect(second.changes).toEqual([false, true])
  activity.watch(second)
  expect(second.changes).toEqual([false, true])
})
