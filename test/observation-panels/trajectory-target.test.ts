import { test } from "bun:test"
import { run } from "./fixtures/trajectory-streams-harness.ts"

test("a task target opens its trajectory from the same sources", () => run("target"))
