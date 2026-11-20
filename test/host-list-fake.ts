/**
 * Test double for the host's paged lists (`message.list`). It enforces the host rules a real
 * host enforces, so a call site that breaks them fails here instead of in a live session:
 * a cursor already encodes the order, so a request carrying both is rejected.
 * Source: @opencode/protocol groups/message.js (`SessionMessagesQuery.cursor`: "Do not combine
 * with order").
 */
export type HostListQuery = { cursor?: string; order?: string; limit?: number; type?: string }

export function assertHostListQuery(query: HostListQuery): void {
  if (query.cursor !== undefined && query.order !== undefined)
    throw new Error("Cursor cannot be combined with order.")
}

/**
 * One page of `items` for `query`. Ascending cursors are the numeric offset of the page's first
 * item; descending cursors are `d:<offset>`, so the cursor, not a repeated `order`, carries the
 * order. Items with a `type` are filtered by `query.type` before paging, as the host does.
 */
export function hostPageOf<T>(
  items: readonly T[],
  query: HostListQuery,
  defaultLimit = 50,
): { data: T[]; cursor: { next?: string } } {
  assertHostListQuery(query)
  const descending = query.cursor ? query.cursor.startsWith("d:") : query.order === "desc"
  const start = query.cursor ? Number(query.cursor.replace(/^d:/, "")) : 0
  const typed = query.type
    ? items.filter((item) => (item as { type?: string }).type === query.type)
    : items
  const ordered = descending ? [...typed].reverse() : typed
  const limit = query.limit ?? defaultLimit
  const next =
    start + limit < ordered.length ? `${descending ? "d:" : ""}${start + limit}` : undefined
  return { data: ordered.slice(start, start + limit), cursor: { ...(next ? { next } : {}) } }
}
