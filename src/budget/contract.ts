import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

export const BudgetSettings = Schema.Struct({
  enabled: Schema.Boolean,
  provider: Schema.Literals(["go", "openrouter"]),
  mode: Schema.Literals(["monthly", "rolling"]),
  weeklyUSD: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
})
export type Settings = typeof BudgetSettings.Type
export const defaults: Settings = {
  enabled: false,
  provider: "go",
  mode: "monthly",
  weeklyUSD: 300,
}
export const Meter = Schema.Struct({ percent: Schema.Finite, resetsAt: Schema.String })
export const Usage = Schema.Struct({
  status: Schema.Literals(["available", "unavailable"]),
  reason: Schema.String,
  monthly: Schema.NullOr(Meter),
  rolling: Schema.NullOr(Meter),
  observedAt: Schema.NullOr(Schema.Number),
  creditUSD: Schema.NullOr(Schema.Number),
  byokUSD: Schema.NullOr(Schema.Number),
  coverageStart: Schema.NullOr(Schema.Number),
})
export type Usage = typeof Usage.Type
export const unavailable = (reason = "Provider usage is unavailable."): Usage => ({
  status: "unavailable",
  reason,
  monthly: null,
  rolling: null,
  observedAt: null,
  creditUSD: null,
  byokUSD: null,
  coverageStart: null,
})
export const Budget = Rpc.define({
  id: "lazers.budget",
  events: {},
  methods: {
    read: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          provider: Schema.Literals(["go", "openrouter"]),
          start: Schema.Number,
          end: Schema.Number,
          timezone: Schema.String,
        }),
      ),
      output: Schema.toStandardSchemaV1(Usage),
    },
  },
})
