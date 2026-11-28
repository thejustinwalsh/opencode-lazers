import { CODE_REVIEW_CONTRACT_VERSION } from "../../contract.ts"
import type {
  CodeReviewComparison,
  CodeReviewFileKind,
  CodeReviewFileStatus,
  CodeReviewHunk,
  CodeReviewSide,
  CodeReviewSourceIdentity,
} from "../../contract.ts"

/** One side of a reviewed file: exactly the tuple a pinned source read takes. */
export type SideSource = {
  side: CodeReviewSide
  /** The content object identity on that side (`object_id`), never a Git ref or a workspace path. */
  revision: string
  kind: CodeReviewFileKind
  size: number | null
}

/**
 * One file of a comparison as the reader sees it: what the displayed base had, what the displayed
 * head has, and how they differ. `base`/`head` are null where the file is absent on that side.
 */
export type ReviewFile = {
  path: string
  status: CodeReviewFileStatus
  base: SideSource | null
  head: SideSource | null
  /** Git hunks of the comparison side, base→head, when the comparison has one layer. */
  hunks: readonly CodeReviewHunk[]
  /** Plan tasks whose diffs touched this file (file-level, not line authorship). */
  attributionTaskIDs: readonly string[]
}

/** A `codeReview.files` row as the stream decodes it. */
export type FileRow = Record<string, unknown>

const text = (value: unknown) => (typeof value === "string" ? value : null)
const int = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null)
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
const hunksOf = (value: unknown): CodeReviewHunk[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is CodeReviewHunk =>
          typeof entry === "object" &&
          entry !== null &&
          ["baseStart", "baseEnd", "headStart", "headEnd"].every(
            (key) => typeof (entry as Record<string, unknown>)[key] === "number",
          ),
      )
    : []

const STATUSES = new Set<CodeReviewFileStatus>([
  "unchanged",
  "added",
  "deleted",
  "modified",
  "conflicted",
])
const KINDS = new Set<CodeReviewFileKind>([
  "text",
  "binary",
  "symlink",
  "submodule",
  "absent",
  "unknown",
])

/** The source of one row's side; null when the file is absent there. */
export function sideOf(row: FileRow | undefined): SideSource | null {
  if (!row) return null
  const revision = text(row.object_id)
  const kind = text(row.kind) as CodeReviewFileKind | null
  const side = text(row.side) as CodeReviewSide | null
  if (!revision || !side || !kind || kind === "absent" || !KINDS.has(kind)) return null
  return { side, revision, kind, size: int(row.size) }
}

/** The sides that hold the displayed head for a comparison, newest layer first. */
export function headSides(comparison: Pick<CodeReviewComparison, "identity" | "sides">) {
  if (comparison.identity.mode !== "live") return ["head"] as const
  // The workspace as captured: untracked files, then the tracked tree with staged and unstaged edits.
  return (["untracked", "unstaged", "staged", "head"] as const).filter((side) =>
    comparison.sides.includes(side),
  )
}

/**
 * Joins the base rows with the displayed head rows by path. Every path that changed in any head
 * layer is listed once, in path order; a path's head is its newest layer.
 */
export function joinFiles(
  comparison: Pick<CodeReviewComparison, "identity" | "sides">,
  base: ReadonlyMap<string, FileRow>,
  heads: ReadonlyMap<CodeReviewSide, ReadonlyMap<string, FileRow>>,
): ReviewFile[] {
  const layers = headSides(comparison)
  const paths = new Set<string>()
  for (const side of layers) for (const path of heads.get(side)?.keys() ?? []) paths.add(path)
  const files: ReviewFile[] = []
  for (const path of [...paths].sort()) {
    const headRow = layers.map((side) => heads.get(side)?.get(path)).find(Boolean)
    const baseRow = base.get(path)
    const baseSide = sideOf(baseRow)
    const headSide = sideOf(headRow)
    if (!baseSide && !headSide) continue
    const status = displayedStatus(comparison, baseSide, headSide, headRow)
    if (status === "unchanged") continue
    files.push({
      path,
      status,
      base: baseSide,
      head: headSide,
      hunks: comparison.identity.mode === "live" ? [] : hunksOf(headRow?.hunks ?? baseRow?.hunks),
      attributionTaskIDs: strings(headRow?.attribution_task_ids ?? baseRow?.attribution_task_ids),
    })
  }
  return files
}

function displayedStatus(
  comparison: Pick<CodeReviewComparison, "identity">,
  base: SideSource | null,
  head: SideSource | null,
  headRow: FileRow | undefined,
): CodeReviewFileStatus {
  const recorded = text(headRow?.status) as CodeReviewFileStatus | null
  if (recorded === "conflicted") return "conflicted"
  // One layer: the row's status is base→head already.
  if (comparison.identity.mode !== "live" && recorded && STATUSES.has(recorded)) return recorded
  // Live layers record status against the layer below; the displayed change is base→workspace.
  if (!base) return head ? "added" : "unchanged"
  if (!head) return "deleted"
  return base.revision === head.revision ? "unchanged" : "modified"
}

/** The pinned source identity of one side of a file in a comparison. */
export function sourceIdentity(
  comparison: Pick<CodeReviewComparison, "identity">,
  path: string,
  source: SideSource,
): CodeReviewSourceIdentity {
  const identity = comparison.identity
  return {
    version: CODE_REVIEW_CONTRACT_VERSION,
    projectID: identity.projectID,
    taskID: identity.taskID,
    planID: identity.planID,
    attemptID: identity.attemptID,
    comparisonID: identity.comparisonID,
    mode: identity.mode,
    side: source.side,
    path,
    revision: source.revision,
  }
}

/** A file whose sides can be read as text (others list without code). */
export const readable = (file: ReviewFile) =>
  (!file.base || file.base.kind === "text" || file.base.kind === "unknown") &&
  (!file.head || file.head.kind === "text" || file.head.kind === "unknown")

/** The short name of a path and its folder, for a narrow row. */
export function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf("/")
  return slash < 0
    ? { name: path, folder: "" }
    : { name: path.slice(slash + 1), folder: path.slice(0, slash) }
}
