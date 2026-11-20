import type { Columns } from "./frame.ts"

/**
 * A source is a named query registered once: a stable key, the total orders it can be read in,
 * the filter it accepts, the columns a list row carries and the cold columns a detail row adds.
 * The reader turns it into keyset SQL; a consumer never writes SQL.
 *
 * Definitions are code, so the registry is bounded by the number of `defineSource` calls in the
 * module graph; it holds no data.
 */
export type SqlValue = string | number | bigint | null
export type SQL = { sql: string; params: SqlValue[] }
export type OrderTerm = { column: string; direction: "asc" | "desc" }

export type SourceDefinition<F, C extends Columns> = {
  name: string // "tasks.list"
  table: string // FROM clause (table or view)
  /** Every table the FROM clause reads. Defaults to `[table]`; required when `table` is a join. */
  tables?: readonly string[]
  key: readonly (keyof C & string)[] // stable row key
  /** Each order is total: it ends with the key columns. Every order column is a list column. */
  orders: Readonly<Record<string, readonly OrderTerm[]>>
  filter(input: F): { where: string; params: readonly (string | number | null)[] } // indexed columns only
  columns: C // list row
  detail?: Columns // cold fields added when window === 1
  /**
   * How `before` and `after` are known. Default `"more"`: one existence probe per side (an index
   * seek, cost independent of table size), reported as 0 or `"more"`. An exact count must be
   * cheap, so the source names how:
   * - `{ exact: "scan" }` (alias `"exact"`): `COUNT(*)` over the keyset range. The author asserts
   *   the table is small; the cost is linear in the rows beyond the window (about 10 ms per
   *   500,000 index entries) and is paid on open, seek and every refresh of a stream that reads it.
   * - `{ exact: { before, after } }`: SQL that reads a stored counter and returns one number for
   *   the rows strictly before or after `edge` (the order-column values of the window's edge row).
   * A slide never counts: it adjusts exact counts by the rows that moved, or probes by reading
   * one extra row. A refresh recounts scan sources (a write to the table can have changed them)
   * and re-probes `"more"` sources.
   */
  count?: SourceCount<F>
}

export type CountBuilder<F> = (input: { filter: F; edge: readonly unknown[] }) => SQL
export type SourceCount<F> =
  | "more"
  | "exact"
  | { exact: "scan" }
  | { exact: { before: CountBuilder<F>; after: CountBuilder<F> } }

export type Source<F, C extends Columns> = SourceDefinition<F, C> & {
  readonly keyColumns: readonly string[]
  /** The tables whose writes can change this source's rows. */
  readonly readsTables: readonly string[]
  /** `more`: probes; `scan`/`stored`: exact numbers. */
  readonly countMode: "more" | "scan" | "stored"
}

/**
 * OpenCode loads every plugin location with its own copy of this module, and a bundled reader
 * worker carries another, so the registry hangs off globalThis the way the core registry does.
 * Defining a name again replaces it: a reload redefines the same source.
 */
const registryKey = Symbol.for("lazers.streams.sources.v1")
const host = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, Source<never, Columns>>
}
const registry = (host[registryKey] ??= new Map())
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/

export function defineSource<F, C extends Columns>(
  definition: SourceDefinition<F, C>,
): Source<F, C> {
  const { name, columns, key } = definition
  const names = new Set(Object.keys(columns))
  const detail = Object.keys(definition.detail ?? {})
  const fail = (message: string): never => {
    throw new Error(`Source ${name}: ${message}`)
  }
  for (const column of [...names, ...detail])
    if (!identifier.test(column)) fail(`column ${column} is not a plain identifier`)
  for (const column of detail)
    if (names.has(column)) fail(`detail column ${column} repeats a list column`)
  if (key.length === 0) fail("needs a key")
  for (const column of key)
    if (!names.has(column)) fail(`key column ${column} is not a list column`)
  const orders = Object.entries(definition.orders)
  if (orders.length === 0) fail("needs at least one order")
  for (const [order, terms] of orders) {
    for (const term of terms)
      if (!names.has(term.column)) fail(`order ${order} column ${term.column} is not a list column`)
    const tail = terms.slice(terms.length - key.length).map((term) => term.column)
    if (terms.length < key.length || [...tail].sort().join() !== [...key].sort().join())
      fail(`order ${order} must end with the key ${key.join(",")}`)
  }
  const tables = definition.tables ?? [definition.table]
  if (tables.length === 0) fail("names no tables")
  for (const table of tables)
    if (!identifier.test(table))
      fail(
        `table ${table} is not a plain identifier; name the tables the FROM clause reads in \`tables\``,
      )
  const count = definition.count ?? "more"
  const countMode =
    count === "more"
      ? "more"
      : count === "exact" || (typeof count === "object" && count.exact === "scan")
        ? "scan"
        : "stored"
  const source: Source<F, C> = {
    ...definition,
    keyColumns: key,
    readsTables: tables,
    countMode,
  }
  registry.set(name, source as unknown as Source<never, Columns>)
  return source
}

/** The source registered under `name` in this thread, or undefined. */
export function findSource(name: string): Source<never, Columns> | undefined {
  return registry.get(name)
}

/** The columns a frame of this window carries: list columns, plus detail columns for one item. */
export function streamColumns(source: Source<never, Columns>, window: number): Columns {
  return window === 1 && source.detail ? { ...source.columns, ...source.detail } : source.columns
}

const quote = (name: string) => `"${name}"`
const orderTerms = (source: Source<never, Columns>, order: string) => {
  const terms = source.orders[order]
  if (!terms) throw new Error(`Source ${source.name} has no order ${JSON.stringify(order)}`)
  return terms
}

export const edgeColumns = (source: Source<never, Columns>, order: string) =>
  orderTerms(source, order).map((term) => term.column)

const sqlValue = (value: unknown): SqlValue => {
  if (value === null || value === undefined) return null
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint")
    return value
  throw new TypeError(`Cannot bind ${typeof value} in a keyset`)
}

/**
 * Rows strictly after (`side: "after"`) or before an edge in the order's direction, as a
 * disjunction over the order columns, with SQLite's null ordering (null is smallest).
 */
function beyond(
  terms: readonly OrderTerm[],
  edge: readonly unknown[],
  side: "after" | "before",
  inclusive: boolean,
): SQL {
  if (edge.length !== terms.length)
    throw new RangeError(`Edge has ${edge.length} values, the order has ${terms.length}`)
  const alternatives: string[] = []
  const params: SqlValue[] = []
  terms.forEach((term, i) => {
    const column = quote(term.column)
    const value = sqlValue(edge[i])
    // After an ascending edge or before a descending one the row's value must be larger.
    const larger = (term.direction === "asc") === (side === "after")
    let step: string
    const own: SqlValue[] = []
    if (larger) {
      if (value === null) step = `${column} IS NOT NULL`
      else {
        step = `${column} > ?`
        own.push(value)
      }
    } else if (value === null) step = "0"
    else {
      step = `(${column} < ? OR ${column} IS NULL)`
      own.push(value)
    }
    if (step === "0") return
    const equal = terms.slice(0, i).map((prior) => `${quote(prior.column)} IS ?`)
    alternatives.push(`(${[...equal, step].join(" AND ")})`)
    for (let j = 0; j < i; j++) params.push(sqlValue(edge[j]))
    params.push(...own)
  })
  if (inclusive) {
    alternatives.push(`(${terms.map((term) => `${quote(term.column)} IS ?`).join(" AND ")})`)
    for (const value of edge) params.push(sqlValue(value))
  }
  return { sql: alternatives.length ? `(${alternatives.join(" OR ")})` : "0", params }
}

const orderBy = (terms: readonly OrderTerm[], reversed: boolean) =>
  terms
    .map((term) => {
      const ascending = (term.direction === "asc") !== reversed
      return `${quote(term.column)} ${ascending ? "ASC" : "DESC"}`
    })
    .join(",")

type RangeMode = "head" | "tail" | "after" | "before" | "from"

/** `head`/`tail` read the first or last rows; the others read from an edge. Limits are bound. */
function rangeQuery(
  source: Source<never, Columns>,
  input: {
    filter: unknown
    order: string
    mode: RangeMode
    edge?: readonly unknown[]
    limit: number
    offset: number
    columns: Columns
  },
): { query: SQL; reversed: boolean } {
  const terms = orderTerms(source, input.order)
  const filter = source.filter(input.filter as never)
  const reversed = input.mode === "tail" || input.mode === "before"
  const conditions = [`(${filter.where.trim() || "1"})`]
  const params: SqlValue[] = [...filter.params]
  if (input.mode === "after" || input.mode === "before" || input.mode === "from") {
    const edge = input.edge
    if (!edge) throw new Error(`Range mode ${input.mode} needs an edge`)
    const keyset = beyond(
      terms,
      edge,
      input.mode === "before" ? "before" : "after",
      input.mode === "from",
    )
    conditions.push(keyset.sql)
    params.push(...keyset.params)
  }
  params.push(input.limit, input.offset)
  const select = Object.keys(input.columns).map(quote).join(",")
  return {
    query: {
      sql: `SELECT ${select} FROM ${source.table} WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy(terms, reversed)} LIMIT ? OFFSET ?`,
      params,
    },
    reversed,
  }
}

/** Rows to read when a window moves: `limit` rows past (`after`) or before an edge, skipping `offset`. */
export function slideQuery(
  source: Source<never, Columns>,
  input: {
    filter: unknown
    order: string
    side: "after" | "before"
    edge: readonly unknown[]
    limit: number
    offset: number
    window: number
  },
) {
  return rangeQuery(source, {
    ...input,
    mode: input.side,
    columns: streamColumns(source, input.window),
  })
}

/** The order-column values of the row with `key`, for turning a key anchor into an edge. */
export function anchorQuery(
  source: Source<never, Columns>,
  input: { filter: unknown; order: string; key: readonly unknown[] },
): SQL {
  if (input.key.length !== source.keyColumns.length)
    throw new RangeError(
      `Key has ${input.key.length} values, ${source.name} has ${source.keyColumns.length}`,
    )
  const filter = source.filter(input.filter as never)
  const select = edgeColumns(source, input.order).map(quote).join(",")
  const match = source.keyColumns.map((column) => `${quote(column)} IS ?`).join(" AND ")
  return {
    sql: `SELECT ${select} FROM ${source.table} WHERE (${filter.where.trim() || "1"}) AND ${match} LIMIT 1`,
    params: [...filter.params, ...input.key.map(sqlValue)],
  }
}

export type WindowAnchor =
  "head" | "tail" | { values: readonly unknown[]; place: "start" | "center" }

export type WindowQuery = {
  /** The columns the rows carry: the list columns, plus the detail columns when `window === 1`. */
  columns: Columns
  rows: SQL
  /** `tail` reads backwards; the reader reverses the rows it gets. */
  reversed: boolean
  /** `center` only: the rows strictly before the anchor, nearest first, `limit` of them. */
  lead?: (limit: number) => SQL
  /** Rows strictly before the window's first row (`edge` = its order values): a count, or 0/1 for `more`. */
  before(edge: readonly unknown[]): SQL
  /** Rows strictly after the window's last row. */
  after(edge: readonly unknown[]): SQL
}

/**
 * The statements for one window. `anchor.values` are the order-column values of the anchor row
 * (`anchorQuery` resolves a key to them), so a window anchored on a deleted row still resolves.
 */
export function windowQuery(
  source: Source<never, Columns>,
  input: { filter: unknown; order: string; anchor: WindowAnchor; window: number },
): WindowQuery {
  const terms = orderTerms(source, input.order)
  const columns = streamColumns(source, input.window)
  const anchor = input.anchor
  const base = { filter: input.filter, order: input.order, columns, offset: 0 }
  const rows =
    anchor === "head"
      ? rangeQuery(source, { ...base, mode: "head", limit: input.window })
      : anchor === "tail"
        ? rangeQuery(source, { ...base, mode: "tail", limit: input.window })
        : rangeQuery(source, { ...base, mode: "from", edge: anchor.values, limit: input.window })
  const filter = source.filter(input.filter as never)
  const where = `(${filter.where.trim() || "1"})`
  const count = (side: "after" | "before", edge: readonly unknown[]): SQL => {
    const stored =
      typeof source.count === "object" && typeof source.count.exact === "object"
        ? source.count.exact
        : undefined
    if (stored) return stored[side]({ filter: input.filter as never, edge })
    const keyset = beyond(terms, edge, side, false)
    const inner = `FROM ${source.table} WHERE ${where} AND ${keyset.sql}`
    return {
      sql:
        source.countMode === "scan"
          ? `SELECT COUNT(*) ${inner}`
          : `SELECT EXISTS(SELECT 1 ${inner})`,
      params: [...filter.params, ...keyset.params],
    }
  }
  return {
    columns,
    rows: rows.query,
    reversed: rows.reversed,
    ...(typeof anchor === "object" && anchor.place === "center"
      ? {
          lead: (limit: number) =>
            rangeQuery(source, {
              ...base,
              mode: "before",
              edge: anchor.values,
              limit,
            }).query,
        }
      : {}),
    before: (edge) => count("before", edge),
    after: (edge) => count("after", edge),
  }
}
