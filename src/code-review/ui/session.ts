import type { FileDiffMetadata } from "@pierre/diffs"
import { batch, createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import type { CodeReviewComparison, CodeReviewSide } from "../contract.ts"
import { headSides, joinFiles, readable, sourceIdentity } from "./model/files.ts"
import type { FileRow, ReviewFile } from "./model/files.ts"
import { readSourceText } from "./model/source-text.ts"
import type { SourceText } from "./model/source-text.ts"
import {
  CONTEXT_LINES,
  lineCounts,
  pierreRegions,
  toLineDiff,
  toPierreDiff,
} from "./renderer/structural.ts"
import type { ChangedRegion, FileTexts } from "./renderer/structural.ts"
import type { ReviewItem } from "./renderer/code-view.tsx"
import type { ReviewTransport } from "./transport.ts"

export type FileView =
  | { phase: "waiting" }
  | { phase: "loading" }
  /** Drawn. `engine` says whether rows are Difftastic's structural comparison or a line diff. */
  | {
      phase: "ready"
      engine: "structural" | "line"
      added: number
      removed: number
      regions: ChangedRegion[]
      degraded?: string
    }
  /** Binary, symlink, submodule or withheld content: listed, not drawn. */
  | { phase: "opaque" }
  | { phase: "failed"; error: string }

/** Files mounted beside the viewport whose text loads before the reader reaches them. */
const AHEAD = 2

/** Rows a file reserves before its text loads: its hunks plus their context, or one region. */
export function estimatedRows(file: ReviewFile): number {
  if (!readable(file)) return 0
  const changed = file.hunks.reduce(
    (sum, hunk) =>
      sum +
      Math.max(
        hunk.baseStart === 0 ? 0 : hunk.baseEnd - hunk.baseStart + 1,
        hunk.headStart === 0 ? 0 : hunk.headEnd - hunk.headStart + 1,
      ),
    0,
  )
  return Math.max(changed, 1) + 2 * CONTEXT_LINES * Math.max(file.hunks.length, 1)
}

const PLACEHOLDER_HIDDEN = 2

/**
 * Stand-in metadata for a file whose text is not loaded: `rows` blank rows between two collapsed
 * regions, so loading it does not move the files after it (Oaink `placeholderDiff`).
 */
export function placeholderDiff(path: string, rows: number): FileDiffMetadata {
  const total = rows + 2 * PLACEHOLDER_HIDDEN
  const lines = Array.from({ length: total }, () => "\n")
  return {
    name: path,
    type: "change",
    lang: "text",
    isPartial: false,
    cacheKey: `lz-review-placeholder:${rows}`,
    deletionLines: lines,
    additionLines: lines,
    splitLineCount: total,
    unifiedLineCount: total,
    hunks:
      rows === 0
        ? []
        : [
            {
              collapsedBefore: PLACEHOLDER_HIDDEN,
              additionStart: PLACEHOLDER_HIDDEN + 1,
              additionCount: rows,
              additionLines: 0,
              additionLineIndex: PLACEHOLDER_HIDDEN,
              deletionStart: PLACEHOLDER_HIDDEN + 1,
              deletionCount: rows,
              deletionLines: 0,
              deletionLineIndex: PLACEHOLDER_HIDDEN,
              hunkContent: [
                {
                  type: "context",
                  lines: rows,
                  additionLineIndex: PLACEHOLDER_HIDDEN,
                  deletionLineIndex: PLACEHOLDER_HIDDEN,
                },
              ],
              splitLineStart: PLACEHOLDER_HIDDEN,
              splitLineCount: rows,
              unifiedLineStart: PLACEHOLDER_HIDDEN,
              unifiedLineCount: rows,
              noEOFCRAdditions: false,
              noEOFCRDeletions: false,
            },
          ],
  } as FileDiffMetadata
}

/**
 * One comparison's files as the reader moves through them. It pages the inventory, reads each
 * file's two pinned sources only when it nears the viewport, and builds its rows from Difftastic's
 * analysis when the transport supplies one, else from a line diff. Everything it starts aborts with
 * it; a result for another comparison is dropped.
 */
export class ReviewSession {
  readonly comparison: CodeReviewComparison
  readonly files: Accessor<readonly ReviewFile[]>
  readonly complete: Accessor<boolean>
  readonly error: Accessor<string | undefined>
  readonly items: Accessor<readonly ReviewItem[]>
  readonly fallback: Accessor<ReadonlySet<string>>
  private readonly setFiles: (files: readonly ReviewFile[]) => void
  private readonly setComplete: (value: boolean) => void
  private readonly setError: (value: string | undefined) => void
  private readonly setItems: (items: readonly ReviewItem[]) => void
  private readonly setFallback: (value: ReadonlySet<string>) => void
  private readonly views = new Map<string, ReturnType<typeof createSignal<FileView>>>()
  private readonly texts = new Map<string, FileTexts>()
  private readonly loads = new Map<string, AbortController>()
  private readonly controller = new AbortController()
  private versions = new Map<string, number>()
  /** Called with a rebuilt item so the view can update one file in place. */
  onItem: ((item: ReviewItem) => void) | undefined

  constructor(
    private readonly transport: ReviewTransport,
    comparison: CodeReviewComparison,
    signal: AbortSignal,
  ) {
    this.comparison = comparison
    signal.addEventListener("abort", () => this.dispose(), { once: true })
    ;[this.files, this.setFiles] = createSignal<readonly ReviewFile[]>([])
    ;[this.complete, this.setComplete] = createSignal(false)
    ;[this.error, this.setError] = createSignal<string | undefined>()
    ;[this.items, this.setItems] = createSignal<readonly ReviewItem[]>([])
    ;[this.fallback, this.setFallback] = createSignal<ReadonlySet<string>>(new Set())
  }

  get signal() {
    return this.controller.signal
  }

  dispose() {
    this.controller.abort()
    for (const load of this.loads.values()) load.abort()
    this.loads.clear()
  }

  view(path: string): FileView {
    return this.viewSignal(path)[0]()
  }

  private viewSignal(path: string) {
    let entry = this.views.get(path)
    if (!entry) {
      entry = createSignal<FileView>({ phase: "waiting" })
      this.views.set(path, entry)
    }
    return entry
  }

  file(path: string) {
    return this.files().find((file) => file.path === path)
  }

  /** Both texts of a loaded file, for quoting a selection. */
  textsOf(path: string) {
    return this.texts.get(path)
  }

  /**
   * Pages the inventory: the base side and each displayed head layer, changed rows only. A Live
   * comparison also needs base rows of paths that changed only in a later layer, read from the
   * whole base inventory and kept only for those paths.
   */
  async load() {
    const signal = this.controller.signal
    const comparisonID = this.comparison.identity.comparisonID
    const base = new Map<string, FileRow>()
    const heads = new Map<CodeReviewSide, Map<string, FileRow>>()
    const publish = () => {
      const files = joinFiles(this.comparison, base, heads)
      batch(() => {
        this.setFiles(files)
        this.setItems(files.map((file) => this.placeholderItem(file)))
      })
    }
    try {
      const page = (target: Map<string, FileRow>) => (rows: FileRow[]) => {
        for (const row of rows) if (typeof row.path === "string") target.set(row.path, row)
        publish()
      }
      const layers = headSides(this.comparison)
      await Promise.all(
        layers.map((side) => {
          const rows = new Map<string, FileRow>()
          heads.set(side, rows)
          return this.transport.files({ comparisonID, side, changedOnly: true }, page(rows), signal)
        }),
      )
      if (this.comparison.identity.mode === "live") {
        const wanted = new Set([...heads.values()].flatMap((rows) => [...rows.keys()]))
        await this.transport.files(
          { comparisonID, side: "base", changedOnly: false },
          (rows) => {
            for (const row of rows)
              if (typeof row.path === "string" && wanted.has(row.path)) base.set(row.path, row)
            publish()
          },
          signal,
        )
      } else
        await this.transport.files(
          { comparisonID, side: "base", changedOnly: true },
          page(base),
          signal,
        )
      publish()
      this.setComplete(true)
    } catch (error) {
      if (!signal.aborted) this.setError(error instanceof Error ? error.message : String(error))
    }
  }

  private nextVersion(path: string) {
    const version = (this.versions.get(path) ?? 0) + 1
    this.versions.set(path, version)
    return version
  }

  private placeholderItem(file: ReviewFile): ReviewItem {
    const version = this.versions.get(file.path)
    const existing = version === undefined ? undefined : this.built.get(file.path)
    if (existing) return existing
    this.versions.set(file.path, version ?? 0)
    return {
      id: file.path,
      type: "diff",
      fileDiff: placeholderDiff(file.path, estimatedRows(file)),
      version: version ?? 0,
    }
  }

  private readonly built = new Map<string, ReviewItem>()

  /**
   * The reader sees these files now: load them and the next few. Files that left the neighborhood
   * keep what they loaded; an unfinished load of one that left is abandoned.
   */
  near(ids: readonly string[]) {
    const files = this.files()
    const index = new Map(files.map((file, position) => [file.path, position]))
    const wanted = new Set<string>()
    for (const id of ids) {
      const position = index.get(id)
      if (position === undefined) continue
      for (let offset = 0; offset <= AHEAD; offset++) {
        const file = files[position + offset]
        if (file) wanted.add(file.path)
      }
    }
    for (const [path, load] of this.loads)
      if (!wanted.has(path)) {
        load.abort()
        this.loads.delete(path)
        if (this.view(path).phase === "loading") this.viewSignal(path)[1]({ phase: "waiting" })
      }
    for (const path of wanted) {
      const phase = this.view(path).phase
      if (phase === "waiting") void this.loadFile(path)
    }
  }

  /** Loads one file now, wherever it is (a jump from the file list or a link). */
  ensure(path: string) {
    if (this.view(path).phase === "waiting") return this.loadFile(path)
    return Promise.resolve()
  }

  retry(path: string) {
    this.viewSignal(path)[1]({ phase: "waiting" })
    return this.loadFile(path)
  }

  private async loadFile(path: string) {
    const file = this.file(path)
    if (!file || this.controller.signal.aborted) return
    const setView = this.viewSignal(path)[1]
    if (!readable(file)) return setView({ phase: "opaque" })
    const load = new AbortController()
    this.loads.set(path, load)
    const signal = AbortSignal.any([this.controller.signal, load.signal])
    setView({ phase: "loading" })
    try {
      const read = (side: ReviewFile["base"]): Promise<SourceText | null> =>
        side
          ? readSourceText(this.transport, sourceIdentity(this.comparison, path, side), signal)
          : Promise.resolve(null)
      const [base, head] = await Promise.all([read(file.base), read(file.head)])
      if (base?.kind === "opaque" || head?.kind === "opaque") {
        setView({ phase: "opaque" })
        return
      }
      const texts: FileTexts = {
        base: base?.kind === "text" ? base.text : null,
        head: head?.kind === "text" ? head.text : null,
      }
      const analysis = await this.transport
        .analysis?.(
          {
            comparison: this.comparison,
            file,
            base: file.base ? sourceIdentity(this.comparison, path, file.base) : null,
            head: file.head ? sourceIdentity(this.comparison, path, file.head) : null,
          },
          signal,
        )
        .catch(() => undefined)
      signal.throwIfAborted()
      // The engine's own result, structural or its degraded line alignment; never another comparison's.
      const engineDiff =
        analysis &&
        analysis.comparisonID === this.comparison.identity.comparisonID &&
        analysis.path === path
          ? analysis.diff
          : undefined
      const structural = engineDiff?.engine === "difftastic" && !engineDiff.degraded
      const fileDiff = engineDiff
        ? toPierreDiff(engineDiff, texts)
        : toLineDiff(path, undefined, texts)
      this.texts.set(path, texts)
      const item: ReviewItem = {
        id: path,
        type: "diff",
        fileDiff,
        version: this.nextVersion(path),
      }
      this.built.set(path, item)
      const counts = lineCounts(fileDiff)
      batch(() => {
        setView({
          phase: "ready",
          engine: structural ? "structural" : "line",
          ...counts,
          regions: pierreRegions(fileDiff),
          ...(engineDiff?.degraded ? { degraded: engineDiff.degraded } : {}),
        })
        const fallback = new Set(this.fallback())
        if (structural) fallback.delete(path)
        else fallback.add(path)
        this.setFallback(fallback)
      })
      this.onItem?.(item)
    } catch (error) {
      if (signal.aborted) return
      setView({ phase: "failed", error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (this.loads.get(path) === load) this.loads.delete(path)
    }
  }
}
