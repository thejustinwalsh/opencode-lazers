import { dirname } from "node:path"
import type { TaskRepository } from "../storage.ts"
import { RETENTION_PRESET_DAYS } from "./contract.ts"
import { RetentionReader } from "./reader.ts"
import { retentionDatabaseSizes } from "./database-size.ts"
import {
  advanceIdentityKeys,
  identityKeysFinished,
  type IdentityKeysProgress,
} from "../runner/identity-migration.ts"
import { incrementalVacuum, type AutoVacuum } from "./vacuum.ts"
import { classifyPlans, retireSlice, type RetentionPreview, type SliceResult } from "./retention.ts"
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
  type WorktreeCandidates,
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
  /** `incremental` returns free pages as the retention pass runs; `none` needs the one-time compaction. */
  autoVacuum: AutoVacuum
  /** Free disk the one-time compaction needs next to the database file. */
  compactionDiskBytes: number
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
  /** Bytes this slice handed back to the filesystem (0 unless the database is incremental). */
  reclaimedBytes: number
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
  private reads: RetentionReader | undefined
  private closed = false
  /** Set once every history table is keyed and indexed: an idle tick then reads nothing for it. */
  private keysComplete = false

  constructor(private readonly deps: Dependencies) {
    installRetentionSchema(deps.repository)
  }

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  private reader() {
    if (this.closed) throw new Error("Retention service is closed")
    return (this.reads ??= new RetentionReader(this.deps.repository.path))
  }

  /** A caller-pinned instant keeps a preview and its purge on the same set, within a day. */
  private asOf(requested: number | undefined) {
    const now = this.now()
    return requested !== undefined && requested <= now && now - requested <= AS_OF_WINDOW_MS
      ? requested
      : now
  }

  private sizes() {
    // A retained service reader can outlive an explicit VACUUM. SQLite connections keep the
    // auto_vacuum header value they saw when opened, so read these file-level PRAGMAs from a fresh
    // lightweight connection rather than the repository connection or its worker's old snapshot.
    return retentionDatabaseSizes(this.deps.repository.path)
  }

  async status(): Promise<RetentionStatus> {
    const now = this.now()
    const read = <T>(run: (db: import("bun:sqlite").Database) => T) =>
      this.deps.repository.read(run)
    const estimates = await this.reader().status({
      now,
      dataDirectory: dirname(this.deps.repository.path),
    })
    return {
      ...this.sizes(),
      presets: estimates.presets,
      superseded: estimates.superseded,
      autoDays: read(autoDays),
      lastRun: read((handle) => lastRuns(handle, 1))[0] ?? null,
    }
  }

  /** The dry run: what a purge at this age removes and what it leaves, with worktrees. */
  async preview(input: { days: number; asOf?: number }): Promise<RetentionPreviewWithTrees> {
    const asOf = this.asOf(input.asOf)
    const estimate = await this.reader().preview({
      now: asOf,
      days: input.days,
      dataDirectory: dirname(this.deps.repository.path),
      projectDirectory: this.deps.repository.projectDirectory,
    })
    const worktrees = await this.inspect(estimate.worktrees)
    return {
      ...estimate.preview,
      asOf,
      worktrees,
      worktreeBytes: worktrees
        .filter((finding) => finding.action === "remove")
        .reduce((sum, finding) => sum + (finding.bytes ?? 0), 0),
    }
  }

  private inspect(candidates: WorktreeCandidates) {
    const { repository, host, probe } = this.deps
    return inspectWorktrees(candidates, {
      project: repository.projectDirectory,
      dataDirectory: dirname(repository.path),
      host,
      ...(probe ? { probe } : {}),
    })
  }

  /**
   * One time-boxed slice of a purge. Call again with the returned `runID` until `done`. Safe to
   * interrupt: nothing is held between slices, and a repeated purge finds nothing left to remove.
   */
  retire(input: {
    days: number | null
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
    /** Null: the superseded-only pass, recorded with days 0 and no worktree removal. */
    days: number | null
    asOf?: number
    runID?: number
    trigger?: "manual" | "auto"
  }): Promise<RetentionSlice> {
    const { repository } = this.deps
    const asOf = this.asOf(input.asOf)
    const trigger = input.trigger ?? "manual"
    const supersededOnly = input.days === null
    const days = input.days ?? RETENTION_PRESET_DAYS[0]
    const runID =
      input.runID ??
      repository.atomic((db) =>
        trigger === "auto"
          ? (openAutoRun(db) ??
            startRun(db, { at: asOf, days: supersededOnly ? 0 : days, trigger }))
          : startRun(db, { at: asOf, days: supersededOnly ? 0 : days, trigger }),
      )
    const started = Date.now()
    const slice: SliceResult = await retireSlice(
      (run) => repository.atomic(run),
      (run) => repository.read(run),
      {
        now: asOf,
        days,
        budgetMs: SLICE_MS,
        batch: BATCH_ROWS,
        ageDependent: !supersededOnly,
        dataDirectory: dirname(repository.path),
      },
    )
    const reclaimedBytes = await this.reclaim(started)
    const worktrees: WorktreeRemoval[] = []
    const skipped: WorktreeSkip[] = []
    let done = slice.done
    if (slice.done && !supersededOnly)
      done = await this.removeWorktrees(asOf, days, started, worktrees, skipped)
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
      reclaimedBytes,
      ...this.sizes(),
    }
  }

  /**
   * Return free pages to the filesystem in steps of INCREMENTAL_VACUUM_PAGES, each in its own
   * transaction with a turn of the event loop between, until the slice has used its time. A no-op
   * on a database that was never compacted once (see vacuum.ts).
   */
  private async reclaim(started: number) {
    const { repository } = this.deps
    let bytes = 0
    while (Date.now() - started < SLICE_MS * 2) {
      const step = repository.atomic((db) => incrementalVacuum(db))
      if (step === 0) break
      bytes += step
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return bytes
  }

  /**
   * Idle step of the integer-key migration (`src/runner/identity-migration.ts`): key the rows of
   * the two history tables written before the key columns existed, a page per transaction; then
   * build each table's integer indexes and drop its text-id indexes one per transaction, handing
   * the freed pages back in steps. While attempts run it keys one page and builds or drops
   * nothing, so no index build holds the write lock under live work. A finished migration costs
   * nothing: the instance remembers it.
   */
  async backfillKeys(budgetMs: number, quiet = true): Promise<IdentityKeysProgress> {
    if (this.keysComplete) return { rows: 0, retired: [], finished: true }
    const { repository } = this.deps
    const started = Date.now()
    const progress = await advanceIdentityKeys(repository, budgetMs, { structural: quiet })
    if (progress.retired.length) await this.reclaim(started)
    this.keysComplete = progress.finished || identityKeysFinished(repository)
    return progress
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
    const candidates = await this.reader().worktrees({
      now: asOf,
      days,
      projectDirectory: repository.projectDirectory,
    })
    const findings = (await this.inspect(candidates)).filter(
      (finding) => finding.action === "remove",
    )
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

  /** Release the service-owned read worker before its repository owner closes. */
  async close() {
    if (this.closed) return
    this.closed = true
    await this.reads?.close()
    this.reads = undefined
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
    // One page while attempts run, the whole slice at a quiet point.
    const busy = this.deps.repository.read(workIsActive)
    await this.backfillKeys(busy ? 1 : SLICE_MS, !busy)
    const due = this.deps.repository.read((db) => (busy ? null : autoRetentionDue(db, this.now())))
    if (due === null) return
    await this.retire({ days: due.days, trigger: "auto" })
  }
}
