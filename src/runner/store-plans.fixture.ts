import type { PlanRow, RunnerStore } from "./store.ts"

/**
 * Every plan of the project with its body, in display order. It materializes every body, so it
 * lives with the fixtures: production code walks `eachPlan()` or reads a page with `planPage()`.
 */
export const allPlans = (store: RunnerStore): PlanRow[] => [...store.eachPlan()]
