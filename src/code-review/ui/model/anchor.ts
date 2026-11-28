import type { ComposerNote, ComposerQuote } from "@opencode/plugin/gui"
import type { CodeReviewMode, CodeReviewSourceIdentity } from "../../contract.ts"
import { encodeProjectID, decodeProjectID } from "../../../tasks/links.ts"
import { TaskReferenceSchema } from "../../../task.ts"

/**
 * A selection pinned to the exact source it was made on: the comparison's identity and revisions,
 * one side's path and content object, an inclusive line range and the selected text itself. A
 * historical, base-side or deleted selection keeps its quote; nothing re-reads today's file at an
 * old line number. It identifies source; it is not evidence or an acceptance gate.
 */
export type ReviewAnchor = {
  source: CodeReviewSourceIdentity
  baseRevision: string | null
  headRevision: string | null
  snapshotID: string | null
  startLine: number
  endLine: number
  /** Character offsets on the first and last line when the reader selected text, not whole lines. */
  startChar?: number
  endChar?: number
  excerpt: string
  /** Unix seconds. */
  createdAt: number
}

/** The comparison request a link reopens. Live snapshots resolve to the current snapshot. */
export type ReviewRequest = {
  mode: CodeReviewMode
  attemptID?: string
  baseAttemptID?: string
  headAttemptID?: string
  planID?: string
}

export type ReviewTarget = {
  projectID: string
  reference: string
  request: ReviewRequest
  /** The comparison the link was made on; a different resolved one means the source moved. */
  comparisonID?: string
  path?: string
  side?: CodeReviewSourceIdentity["side"]
  startLine?: number
  endLine?: number
}

const REVIEW_LINK_PREFIX = ".lazers/review/"
const MODES = new Set<CodeReviewMode>(["task", "attempt", "since", "live", "plan"])
const SIDES = new Set(["base", "head", "staged", "unstaged", "untracked"])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function ownsReviewLink(href: string) {
  return href.startsWith(REVIEW_LINK_PREFIX)
}

/** A plugin link that reopens the exact task, comparison, file and lines. */
export function reviewHref(target: ReviewTarget): string {
  const query = new URLSearchParams()
  query.set("m", target.request.mode)
  if (target.request.attemptID) query.set("a", target.request.attemptID)
  if (target.request.baseAttemptID) query.set("ba", target.request.baseAttemptID)
  if (target.request.headAttemptID) query.set("ha", target.request.headAttemptID)
  if (target.request.planID) query.set("pl", target.request.planID)
  if (target.comparisonID) query.set("c", target.comparisonID)
  if (target.path) query.set("p", target.path)
  if (target.side) query.set("s", target.side)
  if (target.startLine) query.set("l", `${target.startLine}-${target.endLine ?? target.startLine}`)
  const reference = TaskReferenceSchema.parse(target.reference)
  return `${REVIEW_LINK_PREFIX}${encodeProjectID(target.projectID)}/${reference}?${query}`
}

export function parseReviewLink(href: string): ReviewTarget | undefined {
  if (!ownsReviewLink(href)) return undefined
  const [location, search = ""] = href.slice(REVIEW_LINK_PREFIX.length).split("?", 2) as [
    string,
    string?,
  ]
  const parts = location.split("/")
  if (parts.length !== 2) return undefined
  const projectID = decodeProjectID(parts[0]!)
  const reference = parts[1]!
  if (!projectID || !TaskReferenceSchema.safeParse(reference).success) return undefined
  const query = new URLSearchParams(search)
  const mode = query.get("m") as CodeReviewMode | null
  if (!mode || !MODES.has(mode)) return undefined
  const id = (key: string) => {
    const value = query.get(key)
    return value && uuid.test(value) ? value : undefined
  }
  const request: ReviewRequest = { mode }
  const attemptID = id("a")
  const baseAttemptID = id("ba")
  const headAttemptID = id("ha")
  const planID = id("pl")
  if (attemptID) request.attemptID = attemptID
  if (baseAttemptID) request.baseAttemptID = baseAttemptID
  if (headAttemptID) request.headAttemptID = headAttemptID
  if (planID) request.planID = planID
  const target: ReviewTarget = { projectID, reference, request }
  const comparisonID = query.get("c")
  if (comparisonID && /^[0-9a-f]{64}$/.test(comparisonID)) target.comparisonID = comparisonID
  const path = query.get("p")
  if (path) target.path = path
  const side = query.get("s")
  if (side && SIDES.has(side)) target.side = side as ReviewTarget["side"]
  const lines = /^(\d+)-(\d+)$/.exec(query.get("l") ?? "")
  if (lines) {
    const start = Number(lines[1])
    const end = Number(lines[2])
    if (start > 0 && end >= start) {
      target.startLine = start
      target.endLine = end
    }
  }
  return target
}

const SIDE_WORDS: Record<CodeReviewSourceIdentity["side"], string> = {
  base: "before the change",
  head: "after the change",
  staged: "staged in the workspace",
  unstaged: "an uncommitted workspace edit",
  untracked: "untracked in the workspace",
}

export const lineSpan = (anchor: Pick<ReviewAnchor, "startLine" | "endLine">) =>
  anchor.startLine === anchor.endLine
    ? `line ${anchor.startLine}`
    : `lines ${anchor.startLine}–${anchor.endLine}`

export type DiscussIntent = "ask" | "fix"

/**
 * What the composer receives for a selection: the exact quoted text (it survives the draft and the
 * sent message), and a note whose subject pins the comparison and source so the Architect reads the
 * code the reader saw. Neither sends anything.
 */
export function composerParts(input: {
  anchor: ReviewAnchor
  intent: DiscussIntent
  reference: string
  title: string
  origin: string
  href: string
  id: string
}): { quote: ComposerQuote; note: ComposerNote } {
  const { anchor } = input
  const where = `${anchor.source.path} ${lineSpan(anchor)}`
  const side = SIDE_WORDS[anchor.source.side]
  const pinned = [
    `task ${input.reference} (${anchor.source.taskID})`,
    `${anchor.source.mode} comparison ${anchor.source.comparisonID}`,
    anchor.baseRevision ? `base ${anchor.baseRevision}` : undefined,
    anchor.headRevision ? `head ${anchor.headRevision}` : undefined,
    anchor.snapshotID ? `workspace snapshot ${anchor.snapshotID}` : undefined,
    `${anchor.source.side} side of ${anchor.source.path} at object ${anchor.source.revision}`,
    `${lineSpan(anchor)}`,
  ]
    .filter(Boolean)
    .join("; ")
  const ask =
    input.intent === "fix"
      ? "The user requests a correction to this code"
      : "The user asks about this code"
  return {
    quote: {
      type: "quote",
      commentID: `${input.id}:quote`,
      text: anchor.excerpt,
      source: {
        label: `${input.reference} · ${where}`,
        icon: "code",
        subject: `${where} (${side}) in the review of ${input.reference}`,
      },
    },
    note: {
      type: "note",
      origin: input.origin,
      commentID: `${input.id}:note`,
      label: `${input.reference} · ${where}`,
      title: input.title,
      subtitle: input.intent === "fix" ? "Requested fix" : "Review question",
      icon: input.intent === "fix" ? "pencil-line" : "speech-bubble",
      subject: `${ask}, selected in the LAZERS review (${pinned}). Read this pinned source, not the current file at these lines.`,
      comment: "",
      href: input.href,
    },
  }
}
