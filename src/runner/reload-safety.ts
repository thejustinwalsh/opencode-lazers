import type { Database } from "bun:sqlite"

/**
 * Whether a plugin or service reload can run without cutting work off. A location reload
 * reboots the plugin, and the native turn a worker is in the middle of ends unfinished: the
 * runtime sees `interrupted`, holds the plan and re-prompts the worker, so the in-flight step
 * and the prompt cache are lost. Reload when nothing runs.
 */
export type ReloadSafety = {
  safe: boolean
  workers: number
  verifications: number
  /** "2 workers running, 1 verification running, safe to reload: no" */
  line: string
}

export function reloadSafety(db: Database): ReloadSafety {
  const workers = db
    .query<{ n: number }, []>(
      `SELECT count(*) AS n FROM runner_attempts a JOIN runner_plans p ON p.id=a.plan_id
       WHERE a.state IN ('preparing','running') AND p.state NOT IN ('cancelled','integrated')`,
    )
    .get()!.n
  const verifications = db
    .query<{ n: number }, []>(
      `SELECT count(*) AS n FROM runner_effects
       WHERE kind LIKE 'verify:%' AND state IN ('intended','uncertain')`,
    )
    .get()!.n
  const safe = workers === 0 && verifications === 0
  const noun = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
  return {
    safe,
    workers,
    verifications,
    line: `${noun(workers, "worker")} running, ${noun(verifications, "verification")} running, safe to reload: ${safe ? "yes" : "no"}`,
  }
}
