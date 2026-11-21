import { canonicalPath, pickUnit } from "../projects/scope.ts"
import type { ProjectRef, ProjectUnit, UnitAccess } from "../projects/scope.ts"
import { RunnerStore } from "../runner/store.ts"
import { ReadOnlyTaskRepository } from "../storage.ts"
import type { TaskRepository } from "../storage.ts"

export type UnitReads = {
  reads: ObservationReads
  release(): void
}

/** The OpenCode project id recorded for a LAZERS project, when one is. */
function opencodeProjectIDFor(repository: TaskRepository, key: string): string | undefined {
  return repository.read(
    (db) =>
      db
        .query<{ alias: string }, [string]>(
          "SELECT alias FROM lazers_project_aliases WHERE key=? AND kind='opencode-project-id' ORDER BY first_seen_at LIMIT 1",
        )
        .get(key)?.alias,
  )
}

/**
 * The per-checkout plumbing of the progress diagnostics read: which store and project id answer
 * for one checkout, and the all-projects paging over checkouts. Panel show-data is read through
 * streams (`src/streams/`), never here.
 */
export class ObservationReads {
  constructor(
    readonly store: RunnerStore,
    private readonly projectID: string,
  ) {}

  /**
   * The reads of one checkout of one project. The caller's own checkout is this object; any other
   * checkout gets a read-only store of its own. `release` closes what was opened.
   */
  forUnit(unit: ProjectUnit): UnitReads {
    const directory = this.store.repository.projectDirectory
    if (canonicalPath(unit.directory) === canonicalPath(directory))
      return { reads: this, release() {} }
    const repository = new ReadOnlyTaskRepository(this.store.repository.path, unit.directory)
    const store = RunnerStore.readOnly(repository)
    const projectID = opencodeProjectIDFor(repository, unit.project.key) ?? unit.project.key
    return {
      reads: new ObservationReads(store, projectID),
      release() {
        repository.close()
      },
    }
  }

  /** The OpenCode project id this reader's rows are labelled with. */
  get projectIdentity() {
    return this.projectID
  }

  /**
   * One page of an all-projects read: the first readable checkout at or after the cursor, read
   * with that checkout's own project-scope read, marked with its project and the next cursor.
   * Nothing is read for a checkout the caller may not see.
   */
  async allPage<T extends object>(
    input: { scope: { kind: "all"; sessionID: string }; cursor?: string },
    access: UnitAccess,
    read: (unit: UnitReads) => T | Promise<T>,
  ): Promise<T & { project: ProjectRef; nextCursor: string | null }> {
    const picked = await pickUnit(access.units, input.cursor)
    if (!picked) throw new Error("No project is readable in this scope")
    const reads = this.forUnit(picked.unit)
    try {
      return { ...(await read(reads)), project: picked.unit.project, nextCursor: picked.nextCursor }
    } finally {
      reads.release()
    }
  }
}
