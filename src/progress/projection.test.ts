import { expect, test } from "bun:test"
import type { ProgressRow } from "../runner/store.ts"
import { projectProgressFact } from "./projection.ts"

function row(payload: unknown): ProgressRow {
  return {
    seq: 1,
    project_directory: "/workspace/project",
    project_id: "project",
    plan_id: "plan",
    task_id: "task",
    attempt_id: "attempt",
    session_id: "session",
    at: 1_000,
    recorded_at: 1_001,
    source: "tool-hook",
    sources_json: '["tool-hook"]',
    kind: "tool",
    event_ids_json: "[]",
    call_id: "call",
    message_id: "message",
    dedupe_key: "tool:session:call",
    payload: JSON.stringify(payload),
  }
}

test("progress projection exposes only bounded requested paths from target facts", () => {
  const view = projectProgressFact(
    row({
      tool: "patch",
      status: "failed",
      fileTargets: {
        coverage: "observed",
        operation: "patch",
        paths: ["src/changed.ts", "docs/guide.md"],
      },
      patchText: "private patch body must not leak",
      password: "credential=hidden",
    }),
  )
  expect(view).toMatchObject({
    tool: "patch",
    status: "failed",
    fileTargets: {
      coverage: "observed",
      operation: "patch",
      paths: ["src/changed.ts", "docs/guide.md"],
    },
  })
  expect(JSON.stringify(view)).not.toContain("private patch body")
  expect(JSON.stringify(view)).not.toContain("credential=hidden")
})

test("projection drops malformed and external target decoys with explicit omission coverage", () => {
  const view = projectProgressFact(
    row({
      fileTargets: {
        coverage: "observed",
        operation: "read",
        paths: ["src/ok.ts", "../outside.ts", "/private/secret.ts", "file:///private/file"],
      },
    }),
  )
  expect(view.fileTargets).toEqual({
    coverage: "partial",
    operation: "read",
    paths: ["src/ok.ts"],
  })
  expect(projectProgressFact(row({ fileTargets: "not an object" })).fileTargets).toEqual({
    coverage: "omitted",
    operation: null,
    paths: [],
  })
})
