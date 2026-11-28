import { expect, test } from "bun:test"
import { taskChainBase } from "./task-chain-base.ts"
import type { AttemptRow } from "./store.ts"

function attempt(
  number: number,
  base_commit: string,
  artifact: string | null,
  patch: Partial<AttemptRow> = {},
): AttemptRow {
  return {
    id: `attempt-${number}`,
    plan_id: "plan",
    task_id: "task",
    number,
    session_id: `session-${number}`,
    message_id: `message-${number}`,
    workspace: "/repo",
    base_commit,
    artifact,
    policy: "{}",
    state: "accepted",
    started_at: number,
    token_count: null,
    tool_count: 0,
    retry_count: 0,
    cost: null,
    ...patch,
  }
}

test("repair and resume attempts recover the first baseline through contiguous artifact links", () => {
  const attempts = [attempt(1, "a", "b"), attempt(2, "b", "c"), attempt(3, "c", "d")]
  expect(taskChainBase(attempts[2]!, attempts)).toBe("a")
})

test("a retry from a different baseline starts a new attribution chain", () => {
  const attempts = [attempt(1, "a", "b"), attempt(2, "outside", "c")]
  expect(taskChainBase(attempts[1]!, attempts)).toBe("outside")
})

test("attempts from other tasks or plans cannot extend the chain", () => {
  const current = attempt(2, "b", "c")
  const attempts = [
    attempt(1, "a", "b", { plan_id: "other-plan" }),
    attempt(1, "a", "b", { task_id: "other-task" }),
  ]
  expect(taskChainBase(current, attempts)).toBe("b")
})
