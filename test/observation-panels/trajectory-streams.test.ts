import { test } from "bun:test"
import { run } from "./fixtures/trajectory-streams-harness.ts"

// Solid delegates events on the first document it renders into, so each scenario is its own file.
test("the Trajectory panel renders its timeline from stream frames and follows their changes", () =>
  run("pinned"))
