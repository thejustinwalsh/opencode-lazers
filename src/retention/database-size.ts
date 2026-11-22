import { Database } from "bun:sqlite"
import { compactionDiskBytes, spaceState } from "./vacuum.ts"

type ReadOnlyDatabaseOptions = { readonly: true; strict: true }
type ReadOnlyDatabaseFactory = (path: string, options: ReadOnlyDatabaseOptions) => Database

/** File-level SQLite metadata only; never use the repository connection for size reporting. */
export function retentionDatabaseSizes(
  path: string,
  open: ReadOnlyDatabaseFactory = (file, options) => new Database(file, options),
) {
  const db = open(path, { readonly: true, strict: true })
  try {
    const state = spaceState(db)
    return {
      fileBytes: state.pageCount * state.pageSize,
      freeBytes: state.freelistPages * state.pageSize,
      autoVacuum: state.autoVacuum,
      compactionDiskBytes: compactionDiskBytes(state),
    }
  } finally {
    db.close()
  }
}
