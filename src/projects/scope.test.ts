import { afterEach, expect, test } from "bun:test"
import { threeProjects } from "../../test/projects/three-projects.ts"
import { readableUnits } from "./read-access.ts"
import { decodeUnitCursor, encodeUnitCursor, isLoaded, projectUnits, unitIndex } from "./scope.ts"

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
  const cursor = { directory: units[1]!.directory, inner: "abc" }
  expect(decodeUnitCursor(encodeUnitCursor(cursor))).toEqual(cursor)
  expect(unitIndex(units, cursor)).toBe(1)
  expect(unitIndex(units)).toBe(0)
  expect(() => unitIndex(units, { directory: "/gone" })).toThrow("Invalid project cursor")
  expect(() => decodeUnitCursor("not-a-cursor")).toThrow("Invalid project cursor")
})

test("readable units drop a refused project and always keep the caller's own", async () => {
  const three = await fixture()
  const [a, b, c] = three.projects
  const units = projectUnits(a!.repository, () => [])
  const asked: string[][] = []
  const allowed = await readableUnits(
    async (resources) => {
      asked.push(resources)
      return !resources.includes(b!.directory)
    },
    units,
    a!.directory,
  )
  expect(allowed.map((unit) => unit.project.code)).toEqual(["AAA", "CCC"])
  expect(asked).toEqual([[b!.directory], [c!.directory]])
})
