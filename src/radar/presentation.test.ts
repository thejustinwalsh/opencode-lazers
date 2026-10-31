import { expect, test } from "bun:test"
import { ScrollRestoration } from "./presentation.ts"

test("independent pane scroll restores once for each selection key", () => {
  const scheduled: (() => void)[] = []
  const restore = new ScrollRestoration((apply) => scheduled.push(apply))
  const visual = { scrollTop: 0 }
  const detail = { scrollTop: 0 }

  restore.restore("session:flow", true, visual, 120)
  expect(restore.restored("session:flow")).toBe(false)
  scheduled.shift()?.()
  expect(visual.scrollTop).toBe(120)
  expect(restore.restored("session:flow")).toBe(true)
  restore.restore("session:flow", true, visual, 250)
  scheduled.shift()?.()
  expect(visual.scrollTop).toBe(120)

  restore.restore("session:selection", true, detail, 42)
  scheduled.shift()?.()
  expect(detail.scrollTop).toBe(42)
  expect(restore.restored("session:selection")).toBe(true)
})

test("a pending restoration cannot write into a later scope", () => {
  const scheduled: (() => void)[] = []
  const restore = new ScrollRestoration((apply) => scheduled.push(apply))
  const pane = { scrollTop: 0 }
  restore.restore("old", true, pane, 90)
  restore.restore("new", true, pane, 24)
  scheduled.shift()?.()
  expect(pane.scrollTop).toBe(0)
  scheduled.shift()?.()
  expect(pane.scrollTop).toBe(24)
})
