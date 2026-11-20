/** Test bundle entry: the demo's engine and panel mounters, for happy-dom smoke tests. */
export { Engine } from "../src/engine.ts"
export { compile, dataAt } from "../src/story.ts"
export { stories } from "../stories/index.ts"
export const panels = {
  tasks: () => import("../src/panels/tasks.ts"),
  radar: () => import("../src/panels/radar.ts"),
  trajectory: () => import("../src/panels/trajectory.ts"),
  models: () => import("../src/panels/models.ts"),
}
