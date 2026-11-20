import type { Database } from "bun:sqlite"
import type { TaskRepository } from "../storage.ts"
import type { RunnerStore } from "./store.ts"

/** What a measured stretch of code pulled out of SQLite into JavaScript. */
export type ReadMeter = {
  rows: number
  bytes: number
  statements: string[]
  /** Rows and bytes returned by statements whose SQL matches the pattern. */
  of(pattern: RegExp): { rows: number; bytes: number }
  stop(): void
}

/**
 * Count the rows and serialized bytes that `store.read` queries return, so a test can show that a
 * path stops selecting bodies or histories it does not use.
 */
export function meterReads(store: RunnerStore): ReadMeter {
  const original = store.read.bind(store)
  const { meter, wrap } = newMeter(() => {
    store.read = original
  })
  store.read = ((run: (db: Database) => unknown) =>
    original((db) => run(wrap(db)))) as typeof store.read
  return meter
}

/**
 * Count what every `read` and `atomic` call of a repository returns, whichever module makes it.
 * The runner, progress recorder and observers all reach SQLite through these two methods.
 */
export function meterRepository(repository: TaskRepository): ReadMeter {
  const read = repository.read.bind(repository)
  const atomic = repository.atomic.bind(repository)
  const { meter, wrap } = newMeter(() => {
    repository.read = read
    repository.atomic = atomic
  })
  repository.read = ((run: (db: Database) => unknown) =>
    read((db) => run(wrap(db)))) as typeof repository.read
  repository.atomic = ((run: (db: Database) => unknown) =>
    atomic((db) => run(wrap(db)))) as typeof repository.atomic
  return meter
}

/** The same count for code that takes a `Database` directly: use the returned `db` in its place. */
export function meterDatabase(db: Database): { db: Database; meter: ReadMeter } {
  const { meter, wrap } = newMeter(() => {})
  return { db: wrap(db), meter }
}

function newMeter(stop: () => void) {
  const entries: { sql: string; rows: number; bytes: number }[] = []
  const meter: ReadMeter = {
    rows: 0,
    bytes: 0,
    statements: [],
    of(pattern) {
      const hit = entries.filter((entry) => pattern.test(entry.sql))
      return {
        rows: hit.reduce((sum, entry) => sum + entry.rows, 0),
        bytes: hit.reduce((sum, entry) => sum + entry.bytes, 0),
      }
    },
    stop,
  }
  const count = (sql: string, result: unknown) => {
    const rows = Array.isArray(result) ? result : result == null ? [] : [result]
    const bytes = rows.reduce<number>((sum, row) => sum + JSON.stringify(row).length, 0)
    entries.push({ sql, rows: rows.length, bytes })
    meter.rows += rows.length
    meter.bytes += bytes
    meter.statements.push(sql)
  }
  const wrap = (db: Database) =>
    new Proxy(db, {
      get(target, key) {
        if (key !== "query")
          return Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key)
        return (sql: string) => {
          const statement = target.query(sql)
          return new Proxy(statement, {
            get(inner, method) {
              const value = Reflect.get(inner, method)
              if (method !== "all" && method !== "get" && method !== "values")
                return value.bind?.(inner) ?? value
              return (...args: unknown[]) => {
                const result = (value as (...a: unknown[]) => unknown).apply(inner, args)
                count(sql, result)
                return result
              }
            },
          })
        }
      },
    })
  return { meter, wrap }
}
