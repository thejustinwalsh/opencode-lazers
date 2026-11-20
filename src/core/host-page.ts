export type HostOrder = "asc" | "desc"

/**
 * Paging parameters for a host list (`message.list`, `session.list`): the first page names the
 * order, later pages send only the cursor. A host cursor already encodes the order, and the host
 * rejects a request that carries both ("Cursor cannot be combined with order"). Keep the other
 * query fields (`limit`, `type`, filters) beside this spread; they stay legal with a cursor.
 */
export function hostPage<C extends string>(
  order: HostOrder,
  cursor?: C,
): { cursor: C } | { order: HostOrder } {
  return cursor ? { cursor } : { order }
}
