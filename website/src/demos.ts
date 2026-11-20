/**
 * The page's own copy of each demo's shape: what the iframe replays (`story`, `panel`), its design
 * size, and the step captions. They are text the page must show before, or without, the iframe
 * (first paint, no JavaScript, reduced motion). scripts/build-website-demo.ts fails the build
 * when any of it differs from the compiled stories, so it cannot drift from what plays.
 */
export interface DemoDef {
  story: string
  panel: "tasks" | "radar" | "trajectory" | "models" | "local"
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
      "The Tasks panel: four tasks in scheduled order. One runs, then is verified and accepted, and the task waiting on it starts.",
    steps: [
      {
        name: "queue",
        caption: "Tasks are listed in scheduled order. A waiting task links to what it waits on.",
      },
      {
        name: "inspect",
        caption: "Select a task to open its details: state, attempt, and the model that ran it.",
      },
      {
        name: "verify",
        caption: "The runtime verifies the attempt. A worker's report alone does not accept it.",
      },
      {
        name: "next",
        caption: "Once checks pass the task is accepted and its dependents start.",
      },
    ],
  },
  radar: {
    story: "radar",
    panel: "radar",
    size: { width: 420, height: 580 },
    summary:
      "The Radar panel: an Architect and two workers with their models and current calls, a held worker, then the Map view.",
    steps: [
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
        caption:
          "A worker waiting on a question is held and counted; Project scope adds the queue.",
      },
      {
        name: "finish",
        caption:
          "A task that passes verification leaves the list; the Map shows the same work as a tree.",
      },
    ],
  },
  trajectory: {
    story: "trajectory",
    panel: "trajectory",
    size: { width: 440, height: 660 },
    summary:
      "The Trajectory panel: one task's recorded attempts on a timeline. The first attempt fails its tests, the second fills in and is accepted.",
    steps: [
      {
        name: "pick",
        caption: "Trajectory opens on a task: the picker follows the session or the whole project.",
      },
      { name: "live", caption: "A retry attempt fills in as the worker's calls are recorded." },
      {
        name: "inspect",
        caption: "Every mark opens its recorded detail; zoom separates calls seconds apart.",
      },
      {
        name: "settle",
        caption: "Both checks pass and the attempt is accepted; its events stay filterable.",
      },
    ],
  },
  models: {
    story: "models",
    panel: "models",
    size: { width: 440, height: 740 },
    summary:
      "The Models panel: five real models plotted by cost per accepted task at OpenRouter's published prices as of 2026-11-19, a price refresh that re-prices the same usage, then the Assignments view where Implementor is given a different model.",
    steps: [
      {
        name: "compare",
        caption:
          "Compare plots each model by what its accepted tasks cost at the price source's rates, measured from your own runs.",
      },
      {
        name: "inspect",
        caption: "Selecting a model opens its cost per accepted task and the runs behind it.",
      },
      {
        name: "refresh",
        caption:
          "A fresh price snapshot re-prices the same recorded usage: DeepSeek V4 Pro's tokens stay and its cost changes.",
      },
      {
        name: "assign",
        caption:
          "Assignments routes each agent to a model. Moving Implementor off Claude Opus 5.5 changes what its accepted tasks cost.",
      },
    ],
  },
  local: {
    story: "local",
    panel: "local",
    size: { width: 560, height: 150 },
    summary:
      "The local inference indicator in the session header: hidden while off, then downloading, available, and working while a local decision runs.",
    steps: [
      {
        name: "off",
        caption: "Local inference starts off. Nothing loads and the header shows no icon.",
      },
      {
        name: "download",
        caption:
          "Turn it on in Settings, LAZERS. The first request downloads the model; D1 is about 625 MB.",
      },
      {
        name: "ready",
        caption: "The model is resident on the GPU through WebGPU, and the icon reads Available.",
      },
      {
        name: "decide",
        caption:
          "A typed decision runs on the device, and the icon reads Working. Task review uses these decisions.",
      },
    ],
  },
} as const satisfies Record<string, DemoDef>
