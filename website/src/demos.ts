/**
 * The page's own copy of each demo's shape: what the iframe replays (`story`, `panel`), its design
 * size, and the step captions. They are text the page must show before, or without, the iframe
 * (first paint, no JavaScript, reduced motion). scripts/build-website-demo.ts fails the build
 * when any of it differs from the compiled stories, so it cannot drift from what plays.
 */
export interface DemoDef {
  story: string
  panel: "tasks" | "radar" | "trajectory" | "models"
  size: { width: number; height: number }
  /** What the panel is, in a sentence, for the figure's text alternative. */
  summary: string
  steps: { name: string; caption: string }[]
}

export const DEMOS = {
  tasks: {
    story: "hero",
    panel: "tasks",
    size: { width: 420, height: 600 },
    summary:
      "The Tasks panel: four tasks in an Offline sync plan. One runs, enters verification, is accepted once checks pass, and automatically unblocks the next dependent task.",
    steps: [
      {
        name: "queue",
        caption:
          "Tasks line up in dependency order. Every waiting task links directly to its prerequisite.",
      },
      {
        name: "inspect",
        caption:
          "Click any task to inspect its live state, active attempt, file count, and assigned model.",
      },
      {
        name: "verify",
        caption:
          "The runtime runs the verification suite before acceptance—a worker's claim alone never closes a task.",
      },
      {
        name: "next",
        caption: "Once checks pass, the task is accepted and the runtime dispatches its dependent.",
      },
    ],
  },
  radar: {
    story: "radar",
    panel: "radar",
    size: { width: 420, height: 580 },
    summary:
      "The Radar panel: live observability of Architect and two workers with their routed models and in-flight tool calls, a worker held on a question, and the project dependency Map.",
    steps: [
      {
        name: "start",
        caption:
          "Active workers appear as tasks launch; each row streams its model, status, and current tool call.",
      },
      {
        name: "inspect",
        caption:
          "Select a worker to open its live activity lane, elapsed runtime, and recent tool calls.",
      },
      {
        name: "attention",
        caption:
          "When a worker hits an open question, Radar flags and holds it; Project scope reveals the full queue.",
      },
      {
        name: "finish",
        caption:
          "Verified tasks clear the active monitor, while Map renders the entire plan and worker tree.",
      },
    ],
  },
  trajectory: {
    story: "trajectory",
    panel: "trajectory",
    size: { width: 440, height: 700 },
    summary:
      "The Trajectory panel: a task's full flight record across two attempts. Attempt 1 fails its test check; Attempt 2 streams in, passes both checks, and is accepted.",
    steps: [
      {
        name: "pick",
        caption:
          "Switch Trajectory from the current session to the whole project and pick any task to inspect.",
      },
      {
        name: "live",
        caption:
          "Attempt 2 streams onto the timeline as tool calls land, then runs tests and typecheck to reach acceptance.",
      },
      {
        name: "inspect",
        caption:
          "Click any check or tool mark for exact stdout/stderr, and zoom the timeline to separate rapid edits.",
      },
      {
        name: "settle",
        caption:
          "Select the accepted attempt to review its summary and filter its recorded event log.",
      },
    ],
  },
  models: {
    story: "models",
    panel: "models",
    size: { width: 440, height: 740 },
    summary:
      "The Models panel: five models plotted by measured cost per accepted task using recorded OpenRouter catalog prices (2026-11-19), a live price refresh that re-prices historical usage, and role assignment routing.",
    steps: [
      {
        name: "compare",
        caption:
          "Compare plots each model by real cost per accepted task—including retries—priced from your measured runs.",
      },
      {
        name: "inspect",
        caption:
          "Click any model point to inspect its average cost per accepted task and the individual task runs behind it.",
      },
      {
        name: "refresh",
        caption:
          "Refreshing prices re-evaluates recorded token usage against the latest catalog: DeepSeek V4 Pro's tokens stay fixed while its cost updates.",
      },
      {
        name: "assign",
        caption:
          "Assignments routes each role or persona to a provider and model—moving Implementor off Claude Opus 5.5 immediately shifts execution cost.",
      },
    ],
  },
} as const satisfies Record<string, DemoDef>
