import { expect, test } from "bun:test"
import { defineSource, findSource, slideQuery, windowQuery, anchorQuery } from "./source.ts"
import { itemSource } from "./test-source.ts"

const base = {
  table: "t",
  key: ["id"],
  orders: { id: [{ column: "id", direction: "asc" }] },
  filter: () => ({ where: "", params: [] }),
  columns: { id: "int", name: "text" },
  count: "exact",
} as const

test("defineSource registers by name and rejects an order that does not end with the key", () => {
  const source = defineSource({ ...base, name: "unit.a" })
  expect(findSource("unit.a")).toBe(source as never)
  expect(() =>
    defineSource({
      ...base,
      name: "unit.b",
      orders: { bad: [{ column: "name", direction: "asc" }] },
    }),
  ).toThrow(/must end with the key/)
})

test("defineSource rejects keys, order columns and names that are not list columns or identifiers", () => {
  expect(() => defineSource({ ...base, name: "unit.c", key: ["nope"] as never })).toThrow(
    /key column/,
  )
  expect(() =>
    defineSource({
      ...base,
      name: "unit.d",
      orders: {
        id: [
          { column: "ghost", direction: "asc" },
          { column: "id", direction: "asc" },
        ],
      },
    }),
  ).toThrow(/not a list column/)
  expect(() =>
    defineSource({ ...base, name: "unit.e", columns: { id: "int", "a;b": "text" } as never }),
  ).toThrow(/plain identifier/)
  expect(() => defineSource({ ...base, name: "unit.f", detail: { name: "text" } })).toThrow(
    /repeats/,
  )
})

test("windowQuery binds every value and limit; the SQL text depends only on the shape", () => {
  const head = windowQuery(itemSource as never, {
    filter: { group: "g1" },
    order: "rank",
    anchor: "head",
    window: 100,
  })
  expect(head.rows.sql).toContain('ORDER BY "rank" DESC,"id" ASC LIMIT ? OFFSET ?')
  expect(head.rows.params).toEqual(["g1", 100, 0])
  expect(head.reversed).toBe(false)
  const tail = windowQuery(itemSource as never, {
    filter: {},
    order: "rank",
    anchor: "tail",
    window: 100,
  })
  expect(tail.reversed).toBe(true)
  expect(tail.rows.sql).toContain('ORDER BY "rank" ASC,"id" DESC')
  const a = windowQuery(itemSource as never, {
    filter: {},
    order: "rank",
    anchor: { values: [5, 10], place: "center" },
    window: 100,
  })
  const b = windowQuery(itemSource as never, {
    filter: {},
    order: "rank",
    anchor: { values: [6, 99], place: "center" },
    window: 100,
  })
  expect(a.rows.sql).toBe(b.rows.sql)
  expect(a.rows.params).not.toEqual(b.rows.params)
  expect(a.lead?.(7).params.at(-2)).toBe(7)
})

test("a keyset never interpolates a value into the SQL", () => {
  const hostile = "'; DROP TABLE items; --"
  const query = slideQuery(itemSource as never, {
    filter: { group: hostile },
    order: "bucket",
    side: "after",
    edge: [hostile, 3],
    limit: 5,
    offset: 0,
    window: 10,
  })
  expect(query.query.sql).not.toContain("DROP")
  expect(query.query.params).toContain(hostile)
  const point = anchorQuery(itemSource as never, { filter: {}, order: "id", key: [hostile] })
  expect(point.sql).not.toContain("DROP")
  expect(() => anchorQuery(itemSource as never, { filter: {}, order: "id", key: [1, 2] })).toThrow(
    RangeError,
  )
})
