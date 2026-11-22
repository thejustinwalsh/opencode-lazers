export const RELOAD_READ_PAGE_SIZE = 256

/**
 * Accumulate a complete keyset scan while keeping each database read bounded.
 * `cursorFor` must return a unique, ordered key matching the query's ORDER BY.
 */
export function readKeysetPages<Row, Cursor extends string | number | readonly (string | number)[]>(
  readPage: (cursor: Cursor | undefined, limit: number) => readonly Row[],
  cursorFor: (row: Row) => Cursor,
): Row[] {
  const rows: Row[] = []
  let cursor: Cursor | undefined
  while (true) {
    const page = readPage(cursor, RELOAD_READ_PAGE_SIZE)
    rows.push(...page)
    if (page.length < RELOAD_READ_PAGE_SIZE) return rows
    const nextCursor = cursorFor(page[page.length - 1]!)
    if (cursor !== undefined && JSON.stringify(nextCursor) === JSON.stringify(cursor))
      throw new Error("Reload observation page cursor did not advance")
    cursor = nextCursor
  }
}
