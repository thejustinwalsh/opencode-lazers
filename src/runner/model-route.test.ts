import { expect, test } from "bun:test"
import { sameModelSnapshot, sameNativeModel } from "./model-route.ts"
const model = { providerID: "opencode-go", id: "muse-spark-1.3-contributor" }
test("native default and omitted effort are equivalent without changing the requested route", () => {
  expect(sameNativeModel({ ...model, variant: "default" }, model)).toBe(true)
  expect(sameNativeModel(model, { ...model, variant: "default" })).toBe(true)
  expect(model).not.toHaveProperty("variant")
  expect(sameNativeModel({ ...model, variant: "high" }, model)).toBe(false)
  expect(sameNativeModel({ ...model, variant: "default" }, { ...model, variant: "high" })).toBe(
    false,
  )
  expect(sameNativeModel({ ...model, id: "other" }, model)).toBe(false)
  expect(sameNativeModel({ ...model, providerID: "other" }, model)).toBe(false)
})

test("persisted route snapshots keep an omitted effort distinct from the native default sentinel", () => {
  expect(sameModelSnapshot(model, model)).toBe(true)
  expect(sameModelSnapshot(model, { ...model, variant: "default" })).toBe(false)
  expect(sameModelSnapshot({ ...model, variant: "high" }, model)).toBe(false)
  expect(sameModelSnapshot({ ...model, id: "other" }, model)).toBe(false)
  expect(sameModelSnapshot({ ...model, providerID: "other" }, model)).toBe(false)
})
