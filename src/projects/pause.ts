import type { Database } from "bun:sqlite"
import type { TaskRepository } from "../storage.ts"
import { dispatchPauseTransition } from "./pause-machine.ts"
import { GLOBAL_SCOPE } from "./setting-schemas.ts"

/**
 * Project and global dispatch pause. Pause means: no new dispatch; running work finishes and is
 * verified; nothing is cancelled. The effective state is the strictest of plan, project and
 * global. The plan level keeps its own table and machine (`runner_dispatch_controls`); the
 * Architect-contact pause is a separate switch that stops notices, not work.
 */
export type PauseScope = { kind: "global" } | { kind: "project"; key: string }
export type PauseLevel = "plan" | "project" | "global"
export type EffectivePause = {
  level: PauseLevel
  reason: string
  by: string
  at: number
}
export type OuterPause = EffectivePause & { level: "project" | "global" }

type Controls = Pick<TaskRepository, "read" | "atomic" | "changed">

const scopeName = (scope: PauseScope) => {
  if (scope.kind === "global") return GLOBAL_SCOPE
  if (!scope.key || scope.key === GLOBAL_SCOPE)
    throw new Error("A project pause needs a project key")
  return scope.key
}

export function setPause(
  repository: Controls,
  scope: PauseScope,
  input: { paused: boolean; reason: string; by: string },
): void {
  const name = scopeName(scope)
  repository.atomic((db) => {
    const current = db
      .query<{ state: "enabled" | "paused" }, [string]>(
        "SELECT state FROM lazers_dispatch_pause WHERE scope=?",
      )
      .get(name)?.state
    if (!input.paused && current !== "paused") return
    const prefix = scope.kind === "global" ? "GLOBAL" : "PROJECT"
    const state = dispatchPauseTransition(
      current ?? "enabled",
      input.paused ? `${prefix}_DISPATCH_PAUSED` : `${prefix}_DISPATCH_UNPAUSED`,
    )
    db.query(
      `INSERT INTO lazers_dispatch_pause VALUES(?,?,?,?,?)
       ON CONFLICT(scope) DO UPDATE SET state=excluded.state,reason=excluded.reason,
         by=excluded.by,updated_at=excluded.updated_at`,
    ).run(name, state, input.paused ? input.reason : "", input.by, Date.now())
    repository.changed()
  })
}

type Row = { scope: string; reason: string; by: string; updated_at: number }

/** The strictest project or global pause that applies to a checkout directory, on a read handle. */
export function outerPauseIn(db: Database, directory: string): OuterPause | undefined {
  const rows = db
    .query<Row, [string, string]>(
      `SELECT scope,reason,by,updated_at FROM lazers_dispatch_pause
       WHERE state='paused' AND (scope=? OR scope=(SELECT key FROM lazers_project_paths WHERE path=?))`,
    )
    .all(GLOBAL_SCOPE, directory)
  const row = rows.find((r) => r.scope === GLOBAL_SCOPE) ?? rows[0]
  if (!row) return undefined
  return {
    level: row.scope === GLOBAL_SCOPE ? "global" : "project",
    reason: row.reason,
    by: row.by,
    at: row.updated_at,
  }
}

export function outerPause(
  repository: Pick<TaskRepository, "read">,
  directory: string,
): OuterPause | undefined {
  return repository.read((db) => outerPauseIn(db, directory))
}

/** Every paused scope with who set it and why, for Settings. Global first. */
export function pauseRecords(repository: Pick<TaskRepository, "read">) {
  return repository.read((db) =>
    db
      .query<Row, [string]>(
        "SELECT scope,reason,by,updated_at FROM lazers_dispatch_pause WHERE state='paused' ORDER BY scope=? DESC,scope",
      )
      .all(GLOBAL_SCOPE)
      .map((r) => ({
        scope: (r.scope === GLOBAL_SCOPE
          ? { kind: "global" }
          : { kind: "project", key: r.scope }) satisfies PauseScope as PauseScope,
        reason: r.reason,
        by: r.by,
        at: r.updated_at,
      })),
  )
}

/** The pause that holds a plan: global before project before plan. */
export function effectivePause(
  repository: Pick<TaskRepository, "read">,
  planID: string,
): EffectivePause | undefined {
  return repository.read((db) => {
    const plan = db
      .query<{ project_directory: string }, [string]>(
        "SELECT project_directory FROM runner_plans WHERE id=?",
      )
      .get(planID)
    if (!plan) return undefined
    const outer = outerPauseIn(db, plan.project_directory)
    if (outer) return outer
    const own = db
      .query<{ reason: string; updated_at: number }, [string]>(
        "SELECT reason,updated_at FROM runner_dispatch_controls WHERE plan_id=? AND state='paused'",
      )
      .get(planID)
    return own
      ? { level: "plan", reason: own.reason, by: "Architect", at: own.updated_at }
      : undefined
  })
}

/** The held reason a waiting task shows: names the level, then why. */
export function outerPauseReason(pause: Pick<OuterPause, "level" | "reason">): string {
  const label = pause.level === "global" ? "Global pause" : "Project pause"
  return pause.reason.trim() ? `${label}: ${pause.reason.trim()}` : label
}
