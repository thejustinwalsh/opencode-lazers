import { defineStory } from "../src/story.ts"
import type { DemoTask, TasksData } from "../src/panels/tasks-answers.ts"

/**
 * A long, busy queue for checking the Tasks panel the way a real project loads it: hundreds of
 * rows over several plans and every state, with live changes while the list is scrolled.
 * Not on the site's page; open it at /demo/#story=qa-tasks&panel=tasks.
 */
const plans = ["Offline sync", "Search index", "Billing export", "Accessibility pass"]
const verbs = ["Persist", "Retry", "Show", "Resolve", "Index", "Export", "Audit", "Render"]
const things = [
  "the sync queue to disk",
  "failed uploads with backoff and a very long explanation of why",
  "sync state in the status bar",
  "conflicting edits by last writer",
  "the billing ledger as CSV for the finance team's quarterly close",
  "focus order in the settings dialog",
]
const states: DemoTask["state"][] = [
  "queued",
  "queued",
  "ready",
  "blocked",
  "accepted",
  "incorporated",
  "failed",
  "cancelled",
]
const model = { providerID: "opencode-go", id: "muse-spark-1.3", variant: "high" }

const base: DemoTask[] = Array.from({ length: 420 }, (_, index) => {
  const n = 1000 + index
  const state = index < 6 ? "running" : states[index % states.length]!
  return {
    n,
    title: `${verbs[index % verbs.length]} ${things[index % things.length]} (${n})`,
    state,
    plan: plans[index % plans.length]!,
    ...(index > 8 && index % 5 === 0 ? { after: [n - 3] } : {}),
    ...(state === "blocked" ? { reason: "Waiting for the schema review to land" } : {}),
    ...(state === "running" ? { startedMin: 2 + index, calls: 4 + index, files: 2, model } : {}),
  }
})
/** Every few seconds a running task finishes and a queued one starts. */
const tick = (k: number): TasksData => ({
  tasks: base.map((task, index) => {
    if (index === k) return { ...task, state: "accepted" as const }
    if (index === 8 + 8 * k)
      return { ...task, state: "running" as const, startedMin: 0, calls: 1, model }
    return task
  }),
})

export default defineStory<TasksData>({
  id: "qa-tasks",
  panel: "tasks",
  title: "Tasks",
  size: { width: 420, height: 720 },
  initial: { tasks: base },
  chapters: [{ name: "busy", caption: "A long queue that changes while it is read." }],
  steps: [
    { at: 0, chapter: "busy", data: { tasks: base } },
    ...Array.from({ length: 12 }, (_, k) => ({ at: 3000 * (k + 1), data: tick(k) })),
  ],
  end: 40000,
})
