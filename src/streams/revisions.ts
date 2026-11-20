import { databaseChanges, type DatabaseChangeHub } from "../database-events.ts"

/**
 * Tells a reader pool when the writer committed. The feed is `databaseChanges`: the same tracked
 * connection hooks that already drive the rest of LAZERS, so there is no second change detector.
 * One call per event-loop turn carries every table written in it.
 */
export function connectRevisions(
  pool: { revision(revision: number, tables?: readonly string[]): void },
  path: string,
  hub: Pick<DatabaseChangeHub, "subscribe"> &
    Partial<Pick<DatabaseChangeHub, "subscribeTables">> = databaseChanges,
): () => void {
  let revision = 0
  // A hub created by an older copy of the code has no table feed; its coarse feed names no
  // tables, which refreshes every stream (correct, only slower).
  if (hub.subscribeTables)
    return hub.subscribeTables(path, (tables) => pool.revision(++revision, [...tables]))
  return hub.subscribe(
    path,
    () => pool.revision(++revision),
    () => {},
  )
}
