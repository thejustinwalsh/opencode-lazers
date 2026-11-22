import { expect, test } from "bun:test"
import { readFrame, type Columns } from "../../../src/streams/frame.ts"
import {
  MODELS_SOURCES,
  modelAssignmentColumns,
  modelCatalogColumns,
  modelContributorColumns,
  modelPointColumns,
  modelViewColumns,
  modelViewDetail,
} from "../../../src/streams/sources/models-ref.ts"
import { assignmentSettingsOf } from "../../../src/models/assignment-settings.ts"
import { Streams } from "../../../src/streams/contract.ts"
import story from "../stories/models.ts"
import { PROJECT, rpc } from "../src/panels/models-answers.ts"

const server = rpc(() => story.initial)[Streams.id] as unknown as {
  open(input: unknown): { data: string }
}
const decode = (reply: { data: string }, columns: Columns) => {
  const bytes = Uint8Array.from(atob(reply.data), (c) => c.charCodeAt(0))
  const frame = readFrame(bytes.buffer, 0, columns)
  return {
    header: frame.header,
    rows: Array.from(
      { length: frame.header.count },
      (_, i) => frame.row(i) as unknown as Record<string, unknown>,
    ),
  }
}
const view = {
  filters: { persona: null, taskKind: null, period: { from: null, to: null } },
  basis: null,
  taskID: null,
}
const scope = { projectDirectory: PROJECT.canonical, sessionID: "ses-demo" }
const open = (source: string, filter: Record<string, unknown>, window: number, order: string) =>
  server.open({ stream: crypto.randomUUID(), source, filter, order, window })

test("the demo answers the Models view, chart, table and pane streams with real frames", () => {
  const head = decode(open(MODELS_SOURCES.view, { ...scope, view }, 1, "key"), {
    ...modelViewColumns,
    ...modelViewDetail,
  }).rows[0]!
  expect(head).toMatchObject({ state: "ready" })
  expect(Number(head.point_count)).toBeGreaterThan(0)
  const points = decode(
    open(MODELS_SOURCES.points, { ...scope, view }, Number(head.point_count), "chart"),
    modelPointColumns,
  ).rows
  // Priced graph points: the chart draws a dollar figure for each observed model.
  expect(points.some((row) => row.chart !== null)).toBe(true)
  const catalog = decode(
    open(MODELS_SOURCES.catalog, { ...scope, view }, Number(head.entry_count), "rank"),
    modelCatalogColumns,
  )
  expect(catalog.header.after).toBe(0)
  expect(catalog.rows.map((row) => row.rank)).toEqual(catalog.rows.map((_, index) => index))
  // An entry without a price has no price source: the table omits its price, never "unknown".
  for (const row of catalog.rows)
    if (row.price_source === null) expect((row.detail as { price: unknown }).price).toBeNull()
  const first = points[0]!
  const contributors = decode(
    open(
      MODELS_SOURCES.contributors,
      { ...scope, view, configurationID: first.configuration_id },
      40,
      "inspection",
    ),
    modelContributorColumns,
  ).rows
  expect(contributors.length).toBeGreaterThan(0)
  const task = String(contributors.at(-1)!.task_id)
  const lifted = decode(
    open(
      MODELS_SOURCES.contributors,
      { ...scope, view, configurationID: first.configuration_id, taskID: task },
      10,
      "inspection",
    ),
    modelContributorColumns,
  ).rows
  const rest = decode(
    open(
      MODELS_SOURCES.contributors,
      { ...scope, view, configurationID: first.configuration_id, exceptTaskID: task },
      40,
      "inspection",
    ),
    modelContributorColumns,
  ).rows
  expect(lifted.length + rest.length).toBe(contributors.length)
  expect(lifted.every((row) => row.task_id === task)).toBe(true)
})

test("the demo's assignment rows compose to the settings the panel shows", () => {
  const rows = decode(
    open(MODELS_SOURCES.assignments, { ...scope, taskID: null }, 21, "subject"),
    modelAssignmentColumns,
  ).rows
  const settings = assignmentSettingsOf(rows as never, PROJECT.canonical, null)
  expect(settings.personas).toHaveLength(7)
  for (const saved of story.initial.assignments) {
    const persona = settings.personas.find((entry) => entry.persona === saved.subject)
    expect(persona?.layers[saved.scope]?.route).toEqual(saved.route)
  }
})
