import { defineSource } from "./source.ts"

/** Test fixture: a source over the `items` table that `seedItems` (test-harness.ts) creates. */
export const itemColumns = {
  id: "int",
  grp: "text",
  rank: "int",
  bucket: "int",
  title: "text",
  meta: "json",
  done: "bool",
} as const

const definition = {
  table: "items",
  key: ["id"],
  orders: {
    id: [{ column: "id", direction: "asc" }],
    newest: [{ column: "id", direction: "desc" }],
    rank: [
      { column: "rank", direction: "desc" },
      { column: "id", direction: "asc" },
    ],
    bucket: [
      { column: "bucket", direction: "asc" },
      { column: "id", direction: "desc" },
    ],
  },
  filter: (input: { group?: string }) =>
    input.group === undefined
      ? { where: "", params: [] }
      : { where: "grp = ?", params: [input.group] },
  columns: itemColumns,
  detail: { body: "text" },
} as const

export const itemSource = defineSource({ ...definition, name: "test.items", count: "exact" })
export const itemsMoreSource = defineSource({
  ...definition,
  name: "test.items.more",
  count: "more",
})

/** No `count`: the default, an existence probe per side. */
export const itemsDefaultCountSource = defineSource({ ...definition, name: "test.items.default" })

/** A stored counter: the builders return numbers a real source would read from a counter table. */
export const itemsStoredCountSource = defineSource({
  ...definition,
  name: "test.items.stored",
  count: {
    exact: {
      before: ({ edge }) => ({ sql: "SELECT ? + 1000", params: [Number(edge[0])] }),
      after: ({ edge }) => ({ sql: "SELECT 2000 - ?", params: [Number(edge[0])] }),
    },
  },
})
