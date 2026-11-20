import { defineStory } from "../src/story.ts"
import type { Action } from "../src/story.ts"
import type { DemoCall, DemoModel, DemoWorker, RadarData } from "../src/panels/radar-answers.ts"

const spark = (variant: string): DemoModel => ({
  providerID: "opencode-go",
  id: "muse-spark-1.3",
  variant,
})
const architectModel: DemoModel = {
  providerID: "anthropic",
  id: "claude-opus-5-5",
  variant: "high",
}

const q203 = { n: 203, title: "Show sync state in the status bar" }
const q204 = { n: 204, title: "Resolve conflicting edits by last writer" }

/* LZ-202: retries failed uploads. Each snapshot lists the calls the live read would carry. */
const w202calls: DemoCall[] = [
  { tool: "read", path: "src/sync/queue.ts", at: -52000, ms: 700 },
  { tool: "grep", detail: "backoff", at: -44000, ms: 900 },
  { tool: "edit", path: "src/sync/upload.ts", op: "edit", at: -30000, ms: 1400 },
  { tool: "read", path: "src/sync/upload.test.ts", at: -21000, ms: 500 },
  { tool: "edit", path: "src/sync/upload.test.ts", op: "edit", at: -12000, ms: 1800 },
]
const w202 = (calls: DemoCall[], toolCount: number, state: DemoWorker["state"] = "running") =>
  ({
    n: 202,
    title: "Retry failed uploads with backoff",
    state,
    startedAt: -6 * 60_000,
    model: spark("high"),
    calls,
    toolCount,
    files: 3,
  }) satisfies DemoWorker

const w203 = (state: DemoWorker["state"], calls: DemoCall[], extra: Partial<DemoWorker> = {}) =>
  ({
    n: 203,
    title: q203.title,
    state,
    startedAt: 5_500,
    model: spark("medium"),
    calls,
    toolCount: calls.length,
    ...extra,
  }) satisfies DemoWorker

const dispatch = (n: number, at: number): DemoCall => ({
  tool: "task",
  detail: `Dispatch LZ-${n} to a worker`,
  at,
  ms: 700,
})

const architect = (calls: DemoCall[], updatedAt: number): RadarData["architect"] => ({
  busy: true,
  model: architectModel,
  calls,
  updatedAt,
})

const initial: RadarData = {
  rev: 1,
  architect: architect([dispatch(202, -4_000)], -3_300),
  workers: [
    w202([...w202calls, { tool: "edit", path: "src/sync/upload.ts", op: "edit", at: -1_500 }], 11),
  ],
  needsYou: [],
  failed: [],
  queued: [q203, q204],
}

/* 3.0 s: the edit lands and the worker runs the tests. */
const w202tests: DemoCall[] = [
  ...w202calls.slice(1),
  { tool: "edit", path: "src/sync/upload.ts", op: "edit", at: -1_500, ms: 1_600 },
]
const tests = (ms?: number, failed?: string): DemoCall => ({
  tool: "bash",
  detail: "bun test src/sync",
  at: 3_000,
  ...(ms !== undefined ? { ms } : {}),
  ...(failed ? { failed } : {}),
})

/* 5.5 s: the next task starts on a second worker. */
const startCalls203: DemoCall[] = []
/* 7.5 s: it reads the status bar and starts editing. */
const calls203a: DemoCall[] = [
  { tool: "read", path: "src/ui/status-bar.tsx", at: 7_000, ms: 500 },
  { tool: "edit", path: "src/ui/status-bar.tsx", op: "edit", at: 7_500 },
]

/* 11.5 s: LZ-202's test run fails, and it edits again. */
const failure = "1 test failed: retry delay did not double"
const w202failed: DemoCall[] = [
  ...w202tests.slice(1),
  tests(2_600, failure),
  { tool: "edit", path: "src/sync/upload.ts", op: "edit", at: 11_400 },
]
const calls203b: DemoCall[] = [
  { tool: "read", path: "src/ui/status-bar.tsx", at: 7_000, ms: 500 },
  { tool: "edit", path: "src/ui/status-bar.tsx", op: "edit", at: 7_500, ms: 1_800 },
  { tool: "bash", detail: "bun typecheck", at: 14_000 },
]

/* 18 s: LZ-203 stops to ask a question the Architect has to answer. */
const calls203c: DemoCall[] = [
  { tool: "read", path: "src/ui/status-bar.tsx", at: 7_000, ms: 500 },
  { tool: "edit", path: "src/ui/status-bar.tsx", op: "edit", at: 7_500, ms: 1_800 },
  { tool: "bash", detail: "bun typecheck", at: 14_000, ms: 3_200 },
  { tool: "question", detail: "Show the offline state as an icon or as text?", at: 17_800 },
]
const held203 = w203("running", calls203c, {
  held: "Waiting for an answer: show the offline state as an icon or as text?",
  concern: {
    line: "Asked a question and has made no calls since.",
    action: "steer",
    because: "The answer decides how the status bar renders; the worker cannot choose it.",
  },
})
const w202late: DemoCall[] = [
  ...w202failed.slice(1, -1),
  { tool: "edit", path: "src/sync/upload.ts", op: "edit", at: 11_400, ms: 1_500 },
  { ...tests(2_100), at: 13_200 },
]

/* 27 s: LZ-202 passes its own tests and moves to verification. */
const w202verify: DemoCall[] = [
  ...w202late.slice(1),
  { tool: "bash", detail: "bun typecheck", at: 26_800 },
]

/* 29.5 s: LZ-202 is accepted and leaves the list; the next task starts. */
const calls204: DemoCall[] = [{ tool: "read", path: "src/sync/merge.ts", at: 30_300, ms: 600 }]

const set = (rev: number, patch: Partial<RadarData>): Partial<RadarData> => ({ rev, ...patch })

/** The Monitor's scope menu: open it, choose "Project". */
const projectScope: Action[] = [
  { do: "click", sel: 'button[aria-label="This session"]' },
  { do: "click", sel: '[role="menuitem"]', nth: 1 },
]
const row = (n: number): Action => ({ do: "click", sel: `[data-session-id="ses-worker-${n}"]` })

export default defineStory<RadarData>({
  id: "radar",
  panel: "radar",
  title: "Radar",
  size: { width: 420, height: 580 },
  initial,
  chapters: [
    {
      name: "start",
      caption:
        "Workers appear as tasks start; each row shows its model, state and the call in flight.",
    },
    {
      name: "inspect",
      caption:
        "Select a worker to open its details: runtime, calls, an activity lane and recent calls.",
    },
    {
      name: "attention",
      caption: "A worker waiting on a question is held and counted; Project scope adds the queue.",
      setup: [row(203)],
    },
    {
      name: "finish",
      caption:
        "A task that passes verification leaves the list; the Map shows the same work as a tree.",
      setup: projectScope,
    },
  ],
  steps: [
    { at: 0, chapter: "start", data: initial },
    {
      at: 3_000,
      data: set(2, {
        architect: architect([dispatch(202, -4_000)], -3_300),
        workers: [w202([...w202tests, tests()], 12)],
      }),
    },
    {
      at: 5_500,
      data: set(3, {
        architect: architect([dispatch(203, 5_200)], 5_900),
        workers: [w202([...w202tests, tests(2_500)], 12), w203("preparing", startCalls203)],
        queued: [q204],
      }),
    },
    {
      at: 7_500,
      data: set(4, {
        workers: [w202([...w202tests, tests(2_500)], 12), w203("running", calls203a)],
      }),
      actions: [{ do: "hover", sel: '[data-session-id="ses-worker-202"]' }],
    },
    {
      at: 9_000,
      chapter: "inspect",
      actions: [row(202)],
    },
    {
      at: 11_500,
      data: set(5, {
        workers: [w202(w202failed, 14), w203("running", calls203b.slice(0, 2))],
      }),
      actions: [{ do: "click", sel: '.lazers-radar-row-target[data-failed="true"]' }],
    },
    {
      at: 14_000,
      data: set(6, { workers: [w202(w202failed, 14), w203("running", calls203b)] }),
      actions: [row(203)],
    },
    {
      at: 18_000,
      chapter: "attention",
      data: set(7, {
        workers: [w202(w202late, 16), held203],
        needsYou: [q203],
      }),
    },
    { at: 19_500, actions: projectScope },
    { at: 23_000, actions: [row(202)] },
    {
      at: 27_000,
      chapter: "finish",
      data: set(8, { workers: [w202(w202verify, 17, "verifying"), held203] }),
    },
    {
      at: 29_500,
      data: set(9, {
        architect: architect([dispatch(204, 29_800)], 30_500),
        workers: [
          held203,
          { ...w203("running", calls204), n: 204, title: q204.title, startedAt: 29_900 },
        ],
        queued: [],
      }),
    },
    { at: 31_500, actions: [{ do: "click", sel: '[role="tab"]', nth: 1 }] },
    { at: 33_000, actions: [{ do: "click", sel: '[role="button"][aria-label^="Waiting"]' }] },
  ],
  end: 36_000,
})
