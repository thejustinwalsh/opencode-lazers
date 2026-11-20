import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"

/**
 * The raw report of one analysis section, kept as a compressed file instead of a database
 * blob: `audits/<runID>/<analysis>.json.gz` beside the task database. SQLite keeps the summary,
 * the counts and one row per finding; this file is read only to export or to return the
 * original report. It is written once, when the section is stored, and never rewritten.
 */
export function rawReportPath(dataDirectory: string, runID: string, analysis: string): string {
  // `encodeURIComponent` leaves no path separator in a name, and the suffix keeps ".." a file name.
  return join(dataDirectory, "audits", runID, `${encodeURIComponent(analysis)}.json.gz`)
}

/** Writes the serialized report atomically (private mode) and returns the bytes on disk. */
export function writeRawReport(path: string, json: string): number {
  const compressed = gzipSync(json)
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(temporary, compressed, { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return compressed.length
}

export function readRawReport(path: string, analysis: string): string {
  try {
    return gunzipSync(readFileSync(path)).toString("utf8")
  } catch (error) {
    const missing = (error as { code?: string }).code === "ENOENT"
    throw new Error(
      `The raw report of "${analysis}" ${missing ? "is missing" : "cannot be read"} at ${path}; its findings and summary remain in the task database`,
    )
  }
}
