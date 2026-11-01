import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

const ID = Schema.String.check(Schema.isBetweenLength(1, 1024))
const Label = Schema.String.check(Schema.isBetweenLength(0, 1200))
const Dimension = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(2000),
)
const Position = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
const Group = Schema.Struct({ id: ID, label: Label, width: Dimension, height: Dimension })
const Node = Schema.Struct({ id: ID, group: ID, width: Dimension, height: Dimension })
const Edge = Schema.Struct({
  id: ID,
  source: ID,
  target: ID,
  label: Label,
  labelWidth: Dimension,
  labelHeight: Dimension,
})
const Box = Schema.Struct({ id: ID, x: Position, y: Position, width: Dimension, height: Dimension })

export const RadarLayoutInput = Schema.Struct({
  key: Schema.String.check(Schema.isBetweenLength(1, 128)),
  scopeKey: Schema.String.check(Schema.isBetweenLength(1, 512)),
  groups: Schema.Array(Group).check(Schema.isBetweenLength(1, 20)),
  nodes: Schema.Array(Node).check(Schema.isBetweenLength(1, 25_000)),
  edges: Schema.Array(Edge).check(Schema.isBetweenLength(0, 50_000)),
})

export const RadarLayoutResult = Schema.Struct({
  key: Schema.String.check(Schema.isBetweenLength(1, 128)),
  width: Dimension,
  height: Dimension,
  groups: Schema.Array(Box).check(Schema.isBetweenLength(1, 20)),
  nodes: Schema.Array(Box).check(Schema.isBetweenLength(1, 25_000)),
  edges: Schema.Array(
    Schema.Struct({
      id: ID,
      path: Schema.String.check(Schema.isBetweenLength(1, 100_000)),
      arrow: Schema.String.check(Schema.isBetweenLength(1, 1000)),
      labelX: Position,
      labelY: Position,
    }),
  ).check(Schema.isBetweenLength(0, 50_000)),
  elapsedMs: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  workerThreadId: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
})

export const RadarLayout = Ipc.define({
  id: "lazers.radar-layout",
  methods: {
    layout: { input: RadarLayoutInput, output: RadarLayoutResult },
  },
})

export type RadarLayoutInput = typeof RadarLayoutInput.Type
export type RadarLayoutResult = typeof RadarLayoutResult.Type
