import { afterEach, expect, test } from "bun:test"
import { threeProjects } from "../../test/projects/three-projects.ts"
import { lazyGate } from "./read-access.ts"
import {
  decodeUnitCursor,
  encodeUnitCursor,
  isLoaded,
  pickUnit,
  projectUnits,
  unitIndex,
  unitToken,
} from "./scope.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
async function fixture() {
  const three = await threeProjects()
  cleanups.push(() => three.close())
  return three
}

test("units list every checkout in registry order with the project's code and loaded flag", async () => {
  const three = await fixture()
  const [a, b, c] = three.projects
  const units = projectUnits(a!.repository, () => [a!.directory, b!.directory])
  expect(units.map((unit) => [unit.project.code, unit.project.loaded, unit.directory])).toEqual([
    ["AAA", true, a!.directory],
    ["BBB", true, b!.directory],
    ["CCC", false, c!.directory],
  ])
  expect(units.map((unit) => unit.project.key)).toEqual(three.projects.map((p) => p.key))
})

test("a project is loaded when any checkout is live, and loaded is read on every call", async () => {
  const three = await fixture()
  const [a, , c] = three.projects
  let live: string[] = []
  const read = () => projectUnits(a!.repository, () => live).map((unit) => unit.project.loaded)
  expect(read()).toEqual([false, false, false])
  live = [c!.directory]
  expect(read()).toEqual([false, false, true])
  expect(isLoaded(["/a", "/b"], new Set(["/b"]))).toBe(true)
  expect(isLoaded(["/a"], new Set())).toBe(false)
})

test("a cursor round-trips, a gone unit is refused, and garbage is refused", async () => {
  const three = await fixture()
  const units = projectUnits(three.projects[0]!.repository, () => [])
  const cursor = decodeUnitCursor(
    encodeUnitCursor({ directory: units[1]!.directory, inner: "abc" }),
  )
  expect(cursor).toEqual({ unit: unitToken(units[1]!.directory), inner: "abc" })
  expect(JSON.stringify(cursor)).not.toContain(units[1]!.directory)
  expect(unitIndex(units, cursor)).toBe(1)
  expect(unitIndex(units)).toBe(0)
  expect(() => unitIndex(units, { unit: unitToken("/gone") })).toThrow("Invalid project cursor")
  expect(() => decodeUnitCursor("not-a-cursor")).toThrow("Invalid project cursor")
})

test("the gate asks lazily, once per project, never for the caller's own, and a refusal is skipped", async () => {
  const three = await fixture()
  const [a, b, c] = three.projects
  const units = projectUnits(a!.repository, () => [])
  const asked: string[][] = []
  const gate = lazyGate(
    async (resources) => {
      asked.push(resources)
      return !resources.includes(b!.directory)
    },
    units,
    a!.directory,
  )
  const first = await pickUnit(units, undefined, gate)
  expect(first?.unit.project.code).toBe("AAA")
  expect(asked).toEqual([])
  const second = await pickUnit(units, first!.nextCursor!, gate)
  expect(second?.unit.project.code).toBe("CCC")
  expect(asked).toEqual([[b!.directory], [c!.directory]])
  expect(second!.nextCursor).toBeNull()
  await pickUnit(units, first!.nextCursor!, gate)
  expect(asked).toHaveLength(2)
})
