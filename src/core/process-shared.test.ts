import { expect, test } from "bun:test"
import { acquireCore } from "./registry.ts"
import { LruMap, processShared, sharedSessionSet } from "./process-shared.ts"

test("three plugin copies asking for the same shared state get one instance", () => {
  let created = 0
  const copies = [1, 2, 3].map(() =>
    processShared("test.one-instance", () => {
      created++
      return new Map<string, string>()
    }),
  )
  expect(created).toBe(1)
  expect(copies[0]).toBe(copies[1])
  expect(copies[1]).toBe(copies[2])
  const sets = [1, 2, 3].map(() => sharedSessionSet("test.session-set"))
  sets[0]!.add("ses_a")
  expect(sets[2]!.has("ses_a")).toBe(true)
})

test("the least recently used entry goes first and an insert is never refused", () => {
  const lru = new LruMap<string, number>(3)
  for (const [index, key] of ["a", "b", "c"].entries()) lru.set(key, index)
  lru.get("a")
  lru.set("d", 3)
  expect([lru.has("a"), lru.has("b"), lru.has("c"), lru.has("d")]).toEqual([
    true,
    false,
    true,
    true,
  ])
  expect(lru.size).toBe(3)
})

test("three locations of one project acquire one core, one set of per-project state", () => {
  let created = 0
  const handles = [1, 2, 3].map((index) =>
    acquireCore({
      key: "test-core-owners",
      projectDirectory: "/project",
      directory: `/project/location-${index}`,
      ctx: {},
      create: () => {
        created++
        return { core: { sessionAgents: new LruMap<string, string>(8) }, dispose: () => {} }
      },
    }),
  )
  expect(created).toBe(1)
  expect(handles[0]!.core).toBe(handles[2]!.core)
  return Promise.all(handles.map((handle) => handle.release())).then(() => undefined)
})
