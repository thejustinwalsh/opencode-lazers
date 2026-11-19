import { setFallowConfig } from "../../src/audit/config.ts"
import type { RunnerStore } from "../../src/runner/store.ts"

/**
 * Every project needs a Fallow config before work is dispatched. Runner tests that are not about
 * the config gate store one, so the runtime's `fallow-audit` step runs as it would in a project.
 */
export function withFallowConfig<T extends Pick<RunnerStore, "repository">>(store: T): T {
  setFallowConfig(
    store.repository,
    { entry: [] },
    { sessionID: "test", agent: "architect" },
    "test fixture project config",
  )
  return store
}
