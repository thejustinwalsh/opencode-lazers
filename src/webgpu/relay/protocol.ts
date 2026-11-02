import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

const portable = Schema.toStandardSchemaV1
const requestID = Schema.String.check(Schema.isBetweenLength(1, 100))
const claimToken = Schema.String.check(Schema.isBetweenLength(1, 100))
const method = Schema.Literals([
  "settings",
  "configure",
  "review",
  "ask",
  "speak",
  "decide",
  "transcribe",
  "systemOne",
])

const RequestEnvelopeSchema = Schema.Struct({
  requestID,
  method,
  input: Schema.Unknown,
  deadlineAt: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})
const RequestState = Schema.Literals(["pending", "claimed", "delivered", "cancelled"])
const Discovery = portable(
  Schema.Struct({
    requests: Schema.Array(portable(Schema.Struct({ requestID, state: RequestState }))),
  }),
)
const Completion = portable(
  Schema.Union([
    Schema.Struct({ status: Schema.Literal("result"), value: Schema.Unknown }),
    Schema.Struct({
      status: Schema.Literal("error"),
      error: Schema.String.check(Schema.isMaxLength(2_000)),
      uncertain: Schema.Boolean,
    }),
  ]),
)
const RelayEvent = portable(Schema.Struct({ requestID }))
const nothing = portable(Schema.Struct({}))

/** Ephemeral per-location handoff; notifications contain IDs, never inference payloads. */
export const InferenceRelay = Rpc.define({
  id: "lazers.webgpu-relay",
  events: {
    available: { schema: RelayEvent },
    cancelled: { schema: RelayEvent },
  },
  methods: {
    discover: { input: nothing, output: Discovery },
    claim: {
      input: portable(Schema.Struct({ requestID, claimToken })),
      output: portable(Schema.NullOr(RequestEnvelopeSchema)),
    },
    begin: {
      input: portable(Schema.Struct({ requestID, claimToken })),
      output: portable(Schema.NullOr(RequestEnvelopeSchema)),
    },
    complete: {
      input: portable(Schema.Struct({ requestID, claimToken, completion: Completion })),
      output: portable(Schema.Boolean),
    },
    recover: {
      input: portable(Schema.Struct({ requestID })),
      output: portable(Schema.Boolean),
    },
    acknowledge: {
      input: portable(Schema.Struct({ requestID })),
      output: portable(Schema.Boolean),
    },
  },
})

export type RelayRequestEnvelope = typeof RequestEnvelopeSchema.Type
export type RelayRequestMethod = typeof method.Type
export type RelayRequestState = typeof RequestState.Type
export type RelayCompletion = typeof Completion.Type
