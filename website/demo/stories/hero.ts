import { defineStory } from "../src/story.ts"
import type { DemoTask, TasksData } from "../src/panels/tasks-answers.ts"

const plan = "Offline sync"
const model = { providerID: "opencode-go", id: "muse-spark-1.3", variant: "high" }
const t = (tasks: DemoTask[]): TasksData => ({ tasks })

const queued: DemoTask[] = [
  {
    n: 201,
    title: "Persist the sync queue to disk",
    state: "running",
    plan,
    startedMin: 4,
    calls: 9,
    files: 2,
    model,
  },
  { n: 202, title: "Retry failed uploads with backoff", state: "queued", plan, after: [201] },
  { n: 203, title: "Show sync state in the status bar", state: "queued", plan, after: [202] },
  { n: 204, title: "Resolve conflicting edits by last writer", state: "queued", plan },
]
const verifying = queued.map((x) =>
  x.n === 201 ? { ...x, state: "verifying" as const, calls: 14, files: 3 } : x,
)
const accepted = queued.map((x) =>
  x.n === 201
    ? { ...x, state: "accepted" as const }
    : x.n === 202
      ? { ...x, state: "running" as const, startedMin: 0, calls: 3, model }
      : x,
)
const done = accepted.map((x) =>
  x.n === 202
    ? { ...x, state: "accepted" as const }
    : x.n === 203
      ? { ...x, state: "running" as const, startedMin: 0, calls: 2, model }
      : x,
)

const row = (n: number) => `.lazers-tasks-entry[aria-label^="LZ-${n},"]`
const open = { do: "click", sel: ".lazers-details-chevron" } as const

export default defineStory<TasksData>({
  id: "hero",
  panel: "tasks",
  title: "Tasks",
  size: { width: 420, height: 600 },
  initial: t(queued),
  chapters: [
    {
      name: "queue",
      caption: "Tasks are listed in scheduled order. A waiting task links to what it waits on.",
    },
    {
      name: "inspect",
      caption: "Select a task to open its details: state, attempt, and the model that ran it.",
      setup: [{ do: "click", sel: row(201) }],
    },
    {
      name: "verify",
      caption: "The runtime verifies the attempt. A worker's report alone does not accept it.",
      setup: [{ do: "click", sel: row(201) }],
    },
    {
      name: "next",
      caption: "Once checks pass the task is accepted and its dependents start.",
    },
  ],
  steps: [
    {
      at: 0,
      chapter: "queue",
      data: t(queued),
      actions: [
        { do: "wait", ms: 800 },
        { do: "click", sel: '[aria-label="Expand LZ-202"]' },
      ],
    },
    {
      at: 5000,
      chapter: "inspect",
      actions: [
        { do: "click", sel: row(201) },
        { do: "wait", ms: 1500 },
      ],
    },
    { at: 10500, chapter: "verify", data: t(verifying), actions: [{ do: "wait", ms: 2500 }] },
    { at: 14500, chapter: "next", data: t(accepted), actions: [{ do: "click", sel: row(203) }] },
    { at: 19500, data: t(done) },
  ],
  end: 23000,
})
void open
