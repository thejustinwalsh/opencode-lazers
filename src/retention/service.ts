import { dirname } from "node:path"
import type { TaskRepository } from "../storage.ts"
import { RETENTION_PRESET_DAYS } from "./contract.ts"
import {
  classifyPlans,
  previewRetention,
  retireSlice,
  type RetentionPreview,
  type SliceResult,
} from "./retention.ts"
import {
  addToRun,
  autoDays,
  autoRetentionDue,
  installRetentionSchema,
  lastRuns,
  openAutoRun,
  setAutoDays,
  startRun,
  workIsActive,
  type RemovedKinds,
  type RetentionRun,
  type WorktreeRemoval,
} from "./store.ts"
import {
  inspectWorktrees,
  removalBlocker,
  removeWorktree,
  type WorktreeFinding,
  type WorktreeSkip,
  type WorktreeHost,
  type WorktreeProbe,
} from "./worktrees.ts"

/** Time spent per slice and rows per batch: the scheduler and panels are never starved. */
const SLICE_MS = 800
const BATCH_ROWS = 1_000

export type RetentionPreviewWithTrees = RetentionPreview & {
  asOf: number
  worktrees: WorktreeFinding[]
  worktreeBytes: number
}

export type RetentionStatus = {
  fileBytes: number
  /** Space inside the file that deleted rows left behind; reused before the file grows. */
  freeBytes: number
  presets: Array<{ days: number; rows: number; bytes: number }>
  /** Superseded counters and receipts that age does not apply to. */
  superseded: { rows: number; bytes: number }
  autoDays: number | null
  lastRun: RetentionRun | null
}

export type RetentionSlice = {
  runID: number
  asOf: number
  done: boolean
  removed: RemovedKinds
  rows: number
  bytes: number
  worktrees: WorktreeRemoval[]
  /** Removable worktrees left in place at removal time, each with why; the next purge retries. */
  skipped: WorktreeSkip[]
  fileBytes: number
  freeBytes: number
}

type Dependencies = {
  repository: TaskRepository
  host: WorktreeHost
  probe?: WorktreeProbe
  now?: () => number
}

const AS_OF_WINDOW_MS = 24 * 3_600_000

export class RetentionService {
  private running: Promise<RetentionSlice> | undefined

  constructor(private readonly deps: Dependencies) {
    installRetentionSchema(deps.repository)
  }

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  /** A caller-pinned instant keeps a preview and its purge on the same set, within a day. */
  private asOf(requested: number | undefined) {
    const now = this.now()
    return requested !== undefined && requested <= now && now - requested <= AS_OF_WINDOW_MS
      ? requested
      : now
  }

  private sizes() {
    return this.deps.repository.read((db) => {
      const pragma = (name: string) =>
        (db.query<Record<string, number>, []>(`PRAGMA ${name}`).get() ?? {})[name] ?? 0
      const size = pragma("page_size")
      return { fileBytes: pragma("page_count") * size, freeBytes: pragma("freelist_count") * size }
    })
  }

  async status(): Promise<RetentionStatus> {
    const now = this.now()
    const read = <T>(run: (db: import("bun:sqlite").Database) => T) =>
      this.deps.repository.read(run)
    const db = this.deps.repository.read((handle) => handle)
    const presets: RetentionStatus["presets"] = []
    for (const days of RETENTION_PRESET_DAYS) {
      const preview = await previewRetention(db, { now, days, ageIndependent: false })
      presets.push({ days, rows: preview.rows, bytes: preview.bytes })
    }
    const superseded = await previewRetention(db, {
      now,
      days: RETENTION_PRESET_DAYS[0],
      ageDependent: false,
    })
    return {
      ...this.sizes(),
      presets,
      superseded: { rows: superseded.rows, bytes: superseded.bytes },
      autoDays: read(autoDays),
      lastRun: read((handle) => lastRuns(handle, 1))[0] ?? null,
    }
  }

  /** The dry run: what a purge at this age removes and what it leaves, with worktrees. */
  async preview(input: { days: number; asOf?: number }): Promise<RetentionPreviewWithTrees> {
    const asOf = this.asOf(input.asOf)
    const db = this.deps.repository.read((handle) => handle)
    const preview = await previewRetention(db, { now: asOf, days: input.days })
    const { retired } = classifyPlans(db, asOf, input.days)
    const worktrees = await this.inspect(retired)
    return {
      ...preview,
      asOf,
      worktrees,
      worktreeBytes: worktrees
        .filter((finding) => finding.action === "remove")
        .reduce((sum, finding) => sum + (finding.bytes ?? 0), 0),
    }
  }

  private inspect(retired: ReturnType<typeof classifyPlans>["retired"]) {
    const { repository, host, probe } = this.deps
    return inspectWorktrees(
      repository.read((db) => db),
      {
        project: repository.projectDirectory,
        dataDirectory: dirname(repository.path),
        retired,
        host,
        ...(probe ? { probe } : {}),
      },
    )
  }

  /**
   * One time-boxed slice of a purge. Call again with the returned `runID` until `done`. Safe to
   * interrupt: nothing is held between slices, and a repeated purge finds nothing left to remove.
   */
  retire(input: {
    days: number
    asOf?: number
    runID?: number
    trigger?: "manual" | "auto"
  }): Promise<RetentionSlice> {
    this.running ??= this.slice(input).finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async slice(input: {
    days: number
    asOf?: number
    runID?: number
    trigger?: "manual" | "auto"
  }): Promise<RetentionSlice> {
    const { repository } = this.deps
    const asOf = this.asOf(input.asOf)
    const trigger = input.trigger ?? "manual"
    const runID =
      input.runID ??
      repository.atomic((db) =>
        trigger === "auto"
          ? (openAutoRun(db) ?? startRun(db, { at: asOf, days: input.days, trigger }))
          : startRun(db, { at: asOf, days: input.days, trigger }),
      )
    const started = Date.now()
    const slice: SliceResult = await retireSlice(
      (run) => repository.atomic(run),
      (run) => repository.read(run),
      { now: asOf, days: input.days, budgetMs: SLICE_MS, batch: BATCH_ROWS },
    )
    const worktrees: WorktreeRemoval[] = []
    const skipped: WorktreeSkip[] = []
    let done = slice.done
    if (slice.done) done = await this.removeWorktrees(asOf, input.days, started, worktrees, skipped)
    const removed = slice.removed
    repository.atomic((db) =>
      addToRun(db, runID, { kinds: removed, worktrees, skipped }, done, this.now()),
    )
    return {
      runID,
      asOf,
      done,
      removed,
      rows: slice.rows,
      bytes: Object.values(removed).reduce((sum, kind) => sum + kind.bytes, 0),
      worktrees,
      skipped,
      ...this.sizes(),
    }
  }

  /**
   * Returns true when no removable worktree remains to try. One native removal at a time, each
   * after a fresh look at what still owns the tree; anything left in place is reported with its
   * reason, and the next purge (manual, or automatic at its interval) looks again.
   */
  private async removeWorktrees(
    asOf: number,
    days: number,
    started: number,
    removed: WorktreeRemoval[],
    skipped: WorktreeSkip[],
  ) {
    const { host, probe, repository } = this.deps
    const { retired } = classifyPlans(
      repository.read((db) => db),
      asOf,
      days,
    )
    const findings = (await this.inspect(retired)).filter((finding) => finding.action === "remove")
    for (const finding of findings) {
      if (Date.now() - started >= SLICE_MS * 4) return false
      try {
        const current = repository.read((db) => classifyPlans(db, asOf, days).retired)
        const blocker = await removalBlocker(
          repository.read((db) => db),
          finding,
          { retired: new Set(current.map((plan) => plan.id)), host, ...(probe ? { probe } : {}) },
        )
        if (blocker) {
          skipped.push({ path: finding.path, reason: blocker })
          continue
        }
        if (await removeWorktree(finding, host, probe))
          removed.push({ path: finding.path, bytes: finding.bytes })
        else skipped.push({ path: finding.path, reason: "still present after native removal" })
      } catch (error) {
        skipped.push({
          path: finding.path,
          reason: `OpenCode refused: ${String(error).slice(0, 160)}`,
        })
      }
    }
    return true
  }

  settings() {
    return { autoDays: this.deps.repository.read(autoDays) }
  }

  setAuto(days: number | null) {
    this.deps.repository.atomic((db) => setAutoDays(db, days, this.now()))
    return this.settings()
  }

  /**
   * From the scheduler tick: at a quiet point (no attempt preparing, running or verifying) run one
   * slice of the automatic purge when it is due. An unfinished run continues on the next tick.
   */
  async autoTick() {
    if (this.running) return
    const due = this.deps.repository.read((db) =>
      workIsActive(db) ? null : autoRetentionDue(db, this.now()),
    )
    if (due === null) return
    await this.retire({ days: due, trigger: "auto" })
  }
}
