import { defineStory } from "../src/story.ts"
import type { Action } from "../src/story.ts"
import { markID } from "../src/panels/trajectory-answers.ts"
import type {
  DemoCall,
  DemoCheck,
  DemoOtherTask,
  TrajectoryData,
} from "../src/panels/trajectory-answers.ts"

/**
 * LZ-212 fails its first attempt on the tests check; a second attempt retries and fills in call
 * by call while the story plays, then passes both checks and is accepted. All data is invented.
 */
const plan = "Autosave"
const task = {
  n: 212,
  title: "Coalesce rapid autosave writes",
  objective:
    "Coalesce autosave writes that arrive within 250 ms into one disk write, and flush any pending write when the editor closes",
  plan,
}
const others: DemoOtherTask[] = [
  {
    n: 209,
    title: "Add a retry budget to uploads",
    state: "accepted",
    plan: "Upload retries",
    session: false,
  },
  {
    n: 210,
    title: "Show upload errors in the status bar",
    state: "accepted",
    plan: "Upload retries",
    session: false,
  },
  { n: 211, title: "Persist the draft cursor position", state: "accepted", plan, session: true },
  { n: 213, title: "Flush pending drafts on window close", state: "queued", plan, session: true },
]
const queue = "src/autosave/queue.ts"
const flush = "src/autosave/flush.ts"
const spec = "src/autosave/queue.test.ts"
const failure = [
  "bun test v1.3",
  "",
  "src/autosave/queue.test.ts:",
  "(pass) autosave queue > writes a single draft",
  "(fail) autosave queue > coalesces writes within 250 ms",
  "  expected 1 write, received 3",
  "",
  " 5 pass",
  " 1 fail",
].join("\n")
const pass = ["bun test v1.3", "", " 6 pass", " 0 fail"].join("\n")
const model1 = { providerID: "opencode-go", id: "muse-spark-1.3", variant: "high" }
const model2 = { providerID: "opencode-go", id: "muse-spark-1.3", variant: "max" }

/** Attempt 1, already recorded when the story opens. */
const first: DemoCall[] = [
  { key: "read-queue", attempt: 1, tool: "Read", at: 8, s: 1.2, status: "completed", path: queue },
  {
    key: "grep-flush",
    attempt: 1,
    tool: "Grep",
    at: 13,
    s: 0.9,
    status: "completed",
    command: "grep -rn flush src/autosave",
  },
  { key: "read-flush", attempt: 1, tool: "Read", at: 18, s: 1, status: "completed", path: flush },
  { key: "edit-queue", attempt: 1, tool: "Edit", at: 34, s: 3, status: "completed", path: queue },
  { key: "edit-flush", attempt: 1, tool: "Edit", at: 56, s: 4, status: "completed", path: flush },
  {
    key: "test-1",
    attempt: 1,
    tool: "Bash",
    at: 74,
    s: 18,
    status: "error",
    command: "bun test src/autosave",
    result: failure,
  },
  {
    key: "edit-queue-2",
    attempt: 1,
    tool: "Edit",
    at: 104,
    s: 3,
    status: "completed",
    path: queue,
  },
  {
    key: "test-2",
    attempt: 1,
    tool: "Bash",
    at: 120,
    s: 19,
    status: "error",
    command: "bun test src/autosave",
    result: failure,
  },
]
/** Attempt 2, delivered live: `reveal` of them have happened at each step. */
const second: DemoCall[] = [
  { key: "read-queue", attempt: 2, tool: "Read", at: 236, s: 1, status: "completed", path: queue },
  { key: "read-spec", attempt: 2, tool: "Read", at: 240, s: 1.1, status: "completed", path: spec },
  {
    key: "grep-timer",
    attempt: 2,
    tool: "Grep",
    at: 245,
    s: 0.8,
    status: "completed",
    command: "grep -rn setTimeout src/autosave",
  },
  { key: "read-flush", attempt: 2, tool: "Read", at: 250, s: 1, status: "completed", path: flush },
  { key: "edit-queue", attempt: 2, tool: "Edit", at: 268, s: 3, status: "completed", path: queue },
  { key: "edit-flush", attempt: 2, tool: "Edit", at: 276, s: 3, status: "completed", path: flush },
  {
    key: "edit-close",
    attempt: 2,
    tool: "Edit",
    at: 283,
    s: 2,
    status: "completed",
    path: "src/autosave/close.ts",
  },
  { key: "edit-spec", attempt: 2, tool: "Edit", at: 288, s: 2, status: "completed", path: spec },
  {
    key: "test-1",
    attempt: 2,
    tool: "Bash",
    at: 296,
    s: 17,
    status: "completed",
    command: "bun test src/autosave",
    result: pass,
  },
  { key: "fmt", attempt: 2, tool: "Bash", at: 316, s: 4, status: "completed", command: "bun fmt" },
]
const failedCheck: DemoCheck = {
  id: "tests",
  attempt: 1,
  start: 141,
  end: 149,
  result: "failed",
  command: "bun test",
  exit: 1,
  stdout: failure,
}
const testsRunning: DemoCheck = {
  id: "tests",
  attempt: 2,
  start: 326,
  end: null,
  result: "unknown",
  command: "bun test",
}
const testsPassed: DemoCheck = {
  ...testsRunning,
  end: 342,
  result: "passed",
  exit: 0,
  stdout: pass,
}
const typesRunning: DemoCheck = {
  id: "typecheck",
  attempt: 2,
  start: 342,
  end: null,
  result: "unknown",
  command: "bun check",
}
const typesPassed: DemoCheck = { ...typesRunning, end: 350, result: "passed", exit: 0 }

/** The recorded work after `calls` of attempt 2 and the given verification phase. */
function frame(calls: number, phase: 0 | 1 | 2 | 3, version: number): Partial<TrajectoryData> {
  const state = (["running", "verifying", "verifying", "accepted"] as const)[phase]
  return {
    version,
    task: { ...task, state: phase === 3 ? "accepted" : phase === 0 ? "running" : "verifying" },
    attempts: [
      { number: 1, state: "failed", start: 3, end: 150, workEnd: 140, model: model1 },
      {
        number: 2,
        state,
        start: 230,
        end: phase === 3 ? 352 : null,
        workEnd: phase === 0 ? null : 322,
        model: model2,
      },
    ],
    calls: [...first, ...second.slice(0, calls)],
    checks: [
      failedCheck,
      ...([[], [testsRunning], [testsPassed, typesRunning], [testsPassed, typesPassed]] as const)[
        phase
      ],
    ],
  }
}

const initial = { ...frame(0, 0, 1), others } as TrajectoryData

const scopeButton = '.lazers-trajectory-scope button[aria-haspopup="menu"]'
const projectItem = '.lazers-trajectory-scope [role="menuitem"]'
const taskRow = ".lazers-trajectory-recent-row"
const plot = ".lazers-trajectory-scroll"

/** Chapter 1: widen the picker to the project and open LZ-212. */
const pick: Action[] = [
  { do: "click", sel: scopeButton },
  { do: "click", sel: projectItem, nth: 1 },
  { do: "click", sel: taskRow, nth: 1 },
]
/** Chapter 3: inspect the failed attempt, then zoom into the second attempt's burst of edits. */
const inspect: Action[] = [
  { do: "click", sel: `.lazers-trajectory-check-marker[data-result="failed"]` },
  { do: "wait", ms: 900 },
  { do: "click", sel: `[data-mark-id="${markID(1, "test-2")}"]` },
  { do: "wait", ms: 900 },
  { do: "click", sel: '.lazers-trajectory-zoom [aria-label="Zoom in"]' },
  { do: "click", sel: '.lazers-trajectory-zoom [aria-label="Zoom in"]' },
  { do: "click", sel: '.lazers-trajectory-zoom [aria-label="Zoom in"]' },
  { do: "wheel", sel: plot, delta: 260 },
  { do: "wheel", sel: plot, delta: 260 },
  { do: "click", sel: `[data-mark-id="${markID(2, "edit-flush")}"]` },
  { do: "wait", ms: 900 },
  { do: "click", sel: `.lazers-trajectory-zoom button[title^="Fit to panel"]` },
]

export default defineStory<TrajectoryData>({
  id: "trajectory",
  panel: "trajectory",
  title: "Trajectory",
  size: { width: 440, height: 660 },
  initial,
  chapters: [
    {
      name: "pick",
      caption: "Trajectory opens on a task: the picker follows the session or the whole project.",
    },
    {
      name: "live",
      caption: "A retry attempt fills in as the worker's calls are recorded.",
    },
    {
      name: "inspect",
      caption: "Every mark opens its recorded detail; zoom separates calls seconds apart.",
      setup: pick,
    },
    {
      name: "settle",
      caption: "Both checks pass and the attempt is accepted; its events stay filterable.",
      setup: [...pick, ...inspect],
    },
  ],
  steps: [
    { at: 0, chapter: "pick", data: frame(0, 0, 1), actions: [{ do: "wait", ms: 700 }, ...pick] },
    { at: 6500, chapter: "live", data: frame(2, 0, 2) },
    { at: 8000, data: frame(4, 0, 3) },
    { at: 9500, data: frame(6, 0, 4) },
    { at: 11000, data: frame(8, 0, 5) },
    { at: 12500, data: frame(10, 0, 6) },
    { at: 14000, chapter: "inspect", actions: inspect },
    { at: 24000, chapter: "settle", data: frame(10, 1, 7) },
    { at: 25500, data: frame(10, 2, 8) },
    { at: 27000, data: frame(10, 3, 9) },
    {
      at: 28000,
      actions: [
        { do: "click", sel: ".lazers-trajectory-attempt", nth: 1 },
        { do: "click", sel: ".lazers-kit-disclosure-toggle", nth: 0 },
        { do: "click", sel: ".lazers-trajectory-filter", nth: 1 },
      ],
    },
  ],
  end: 33500,
})
