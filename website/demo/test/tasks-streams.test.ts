import { expect, test } from "bun:test"
import { readFrame } from "../../../src/streams/frame.ts"
import {
  taskBucketCountColumns,
  taskScheduleColumns,
} from "../../../src/streams/sources/tasks-ref.ts"
import { taskStreams } from "../src/panels/tasks-streams.ts"
import type { DemoTask } from "../src/panels/tasks-answers.ts"

const plan = "Plan"
const tasks: DemoTask[] = Array.from({ length: 12 }, (_, index) => ({
  n: 100 + index,
  title: `Task ${index}`,
  state: index < 2 ? "running" : index < 9 ? "queued" : "accepted",
  plan,
}))
const decode = <C extends Record<string, "text" | "int" | "bool" | "json">>(
  reply: { data: string },
  columns: C,
) => {
  const bytes = Uint8Array.from(atob(reply.data), (c) => c.charCodeAt(0))
  return readFrame(bytes.buffer, 0, columns)
}
const open = (server: ReturnType<typeof taskStreams>, window: number, anchor?: never) =>
  server.open({
    stream: "s",
    source: "tasks.schedule",
    filter: { state: "all" },
    order: "schedule",
    window,
    ...(anchor ? { anchor } : {}),
  })

test("the demo's tasks.schedule stream windows, slides and seeks over the mock rows", () => {
  const server = taskStreams(() => ({ tasks }), "/demo")
  let frame = decode(open(server, 5), taskScheduleColumns)
  expect(frame.header).toMatchObject({ count: 5, before: 0, after: 7 })
  expect(frame.row(0).reference).toBe("LZ-100")
  frame = decode(server.slide({ stream: "s", delta: 4 }), taskScheduleColumns)
  expect(frame.header).toMatchObject({ count: 5, before: 4, after: 3 })
  expect(frame.row(0).reference).toBe("LZ-104")
  frame = decode(server.slide({ stream: "s", delta: 100 }), taskScheduleColumns)
  expect(frame.header).toMatchObject({ before: 7, after: 0 })
  frame = decode(
    server.seek({
      stream: "s",
      anchor: { key: ["00000001-0000-4000-8000-000000000066"], place: "start" },
    }),
    taskScheduleColumns,
  )
  expect(frame.row(0).reference).toBe("LZ-102")
})

test("the demo answers chip counters and the index as ready", () => {
  const server = taskStreams(() => ({ tasks }), "/demo")
  const counts = decode(
    server.open({
      stream: "c",
      source: "tasks.bucketCounts",
      filter: {},
      order: "bucket",
      window: 20,
    }),
    taskBucketCountColumns,
  )
  const byBucket = new Map(
    Array.from({ length: counts.header.count }, (_, i) => [counts.row(i).bucket, counts.row(i).n]),
  )
  expect(byBucket.get("running")).toBe(2)
  expect(byBucket.get("queued")).toBe(7)
  expect(byBucket.get("accepted")).toBe(3)
  const index = decode(
    server.open({ stream: "i", source: "tasks.index", filter: {}, order: "project", window: 1 }),
    { project_directory: "text", ready: "bool" },
  )
  expect(index.row(0).ready).toBe(true)
})
