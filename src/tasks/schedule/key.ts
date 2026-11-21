import type { Bucket } from "./buckets.ts"

/**
 * State rank of a task for the list: the `STATE_RANK_SQL` of the old schedule query
 * (`src/tasks/schedule-order.ts`). A cancelled plan or node is cancelled and a blocked plan holds
 * its running node out of Running.
 *
 *   0 running or verifying   1 other open   2 accepted   3 integrated   4 failed   5 cancelled
 */
export function rankOf(facts: {
  nodeState: string | null
  planState: string | null
}): 0 | 1 | 2 | 3 | 4 | 5 {
  const { nodeState: node, planState: plan } = facts
  if (node === "cancelled" || plan === "cancelled") return 5
  if (node === "failed" || node === "exhausted") return 4
  if (node === "incorporated") return 3
  if (node === "accepted") return 2
  if ((node === "running" || node === "verifying") && plan !== "blocked") return 0
  return 1
}

/**
 * The chip a row counts under. It follows the status the row displays: a task held back by a
 * reservation, a prerequisite plan or an adoption shows Blocked and counts under Blocked (the old
 * filters read only stored node and plan state, so such a task counted under Queued).
 */
export function bucketOf(facts: {
  nodeState: string | null
  planState: string | null
  /** The effective status the row displays. */
  status: string
  paused: boolean
}): Bucket {
  const { nodeState: node, planState: plan, status } = facts
  if (node === null) return "open"
  if (plan === "cancelled" || node === "cancelled") return "cancelled"
  if (node === "failed" || node === "exhausted") return "failed"
  if (node === "incorporated") return "integrated"
  if (node === "accepted") return "accepted"
  if (node === "blocked" || plan === "blocked") return "blocked"
  if ((node === "queued" || node === "ready") && facts.paused) return "paused"
  if (status === "blocked") return "blocked"
  if (node === "running") return "running"
  if (node === "queued") return "queued"
  return "open"
}

/**
 * Whether the task waits on the owner: its own node, or its plan, is recorded Blocked (and the
 * task is not finished). A task held back by a reservation, a prerequisite plan or an adoption
 * shows Blocked but does not need the owner; this is what separates the two, and what the old
 * Needs you filter read.
 */
export function ownerHoldOf(facts: { nodeState: string | null; planState: string | null }) {
  const { nodeState: node, planState: plan } = facts
  if (node === null || plan === "cancelled") return false
  if (["cancelled", "failed", "exhausted", "incorporated", "accepted"].includes(node)) return false
  return node === "blocked" || plan === "blocked"
}

export type KeyFacts = {
  planID: string | null
  nodeState: string | null
  planState: string | null
  /** Plan body priority; 0, null or negative is none. */
  priority: number | null
  planSeq: number | null
  ordinal: number | null
  seq: number
  /** 0 for open ranks. */
  finishedAt: number
}

const MAX_PRIORITY = 2147483647
const FINISH_CEILING = 9_999_999_999_999
const SEQ_CEILING = Number.MAX_SAFE_INTEGER

/** Ascending priority key: 1 first, none last (`prioritySortSQL`). */
export const priorityKeyOf = (priority: number | null | undefined) =>
  typeof priority === "number" && priority > 0 ? priority : MAX_PRIORITY + 1

const pad = (value: number, width: number) => String(value).padStart(width, "0")

/**
 * The seven terms of the old order as fixed-width decimal fields, so byte order equals the old
 * `ORDER BY`:
 *   rank | unplanned open | -finished | priority | plan rowid | ordinal | +-task seq
 * Open ranks order by plan then ordinal then oldest task; finished ranks and unplanned open tasks
 * by newest task first.
 */
export function encodeSortKey(facts: KeyFacts): string {
  const rank = rankOf(facts)
  const unplanned = facts.planID === null
  const open = rank <= 1
  const tie = open && !unplanned ? facts.seq : SEQ_CEILING - facts.seq
  return [
    rank,
    open && unplanned ? 1 : 0,
    pad(FINISH_CEILING - facts.finishedAt, 13),
    pad(priorityKeyOf(facts.priority), 10),
    pad(open ? (facts.planSeq ?? 0) : 0, 16),
    pad(open ? (facts.ordinal ?? 0) : 0, 9),
    pad(tie, 16),
  ].join("")
}

/**
 * The buckets a panel state filter selects; `undefined` selects every bucket. `legacy` is the
 * default filter of `Tasks.query` (everything not accepted, integrated or cancelled).
 */
export function bucketsFor(state: string | undefined): readonly Bucket[] | undefined {
  switch (state) {
    case undefined:
    case "all":
      return undefined
    case "open":
      return ["running", "queued", "paused", "blocked", "open"]
    case "completed":
      return ["accepted", "integrated"]
    case "legacy":
      return ["running", "queued", "paused", "blocked", "open", "failed"]
    default:
      return [state as Bucket]
  }
}
