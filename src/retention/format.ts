import { MAX_RETENTION_DAYS } from "./contract.ts"
import type { RetentionStatusView } from "./contract.ts"

export const CUSTOM = "custom"

/** "30" for a preset or the custom field's digits; undefined while it is not a valid day count. */
export function parseDays(choice: string, custom: string): number | undefined {
  const text = choice === CUSTOM ? custom.trim() : choice
  if (!/^\d+$/.test(text)) return undefined
  const days = Number(text)
  return days >= 1 && days <= MAX_RETENTION_DAYS ? days : undefined
}

/** Decimal units, matching what the operating system reports for a file. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${Math.round(bytes)} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1_000
  let unit = 0
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export const formatCount = (count: number) => count.toLocaleString("en-US")
export const plural = (count: number, noun: string) =>
  `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`

/**
 * Free pages are "large" once they are a tenth of the file or more: the point where a compaction
 * returns a visible share of the disk. Display only; nothing is refused below it.
 */
export const COMPACTION_FREE_SHARE = 0.1

export const COMPACTION_COMMAND = "bun scripts/compact-database.ts --db <path> --yes"

/** The one-time compaction notice: only for a database that never returns free pages by itself. */
export function compactionNotice(status: RetentionStatusView): string | undefined {
  if (status.autoVacuum !== "none") return undefined
  if (status.freeBytes <= 0 || status.freeBytes < status.fileBytes * COMPACTION_FREE_SHARE)
    return undefined
  return `${formatBytes(status.freeBytes)} of the file is free, and it will not shrink until a one-time compaction. Stop the service and Desktop, then run ${COMPACTION_COMMAND} (needs ${formatBytes(status.compactionDiskBytes)} of free disk).`
}
