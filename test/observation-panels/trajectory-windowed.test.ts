import { test } from "bun:test"
import { run } from "./fixtures/trajectory-streams-harness.ts"

test("the timeline window follows the viewport to rows it did not hold", () => run("windowed"))
