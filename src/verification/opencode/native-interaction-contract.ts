import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

const portable = Schema.toStandardSchemaV1
const shortText = Schema.String.check(Schema.isBetweenLength(1, 512))
const pathText = Schema.String.check(Schema.isBetweenLength(1, 4_096))
const positiveInt = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }),
)
const nonnegativeInt = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 2_147_483_647 }),
)
const boundedText = Schema.String.check(Schema.isMaxLength(4_000))
const stringList = Schema.Array(shortText).check(Schema.isMaxLength(100))
const empty = portable(Schema.Struct({}))

export const NativeProcessIdentity = Schema.Struct({
  pid: positiveInt,
  startedAt: shortText,
  command: pathText,
})

export const NativeCandidateIdentity = Schema.Struct({
  workspace: pathText,
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  dirtyPaths: stringList,
  pluginEntry: pathText,
  guiEntry: pathText,
  guiEntryBytes: nonnegativeInt,
  guiEntryModifiedAt: shortText,
  architectDescription: boundedText,
})

export const NativeBinding = Schema.Struct({
  ownerID: shortText,
  createdAt: shortText,
  root: pathText,
  candidate: NativeCandidateIdentity,
  target: Schema.Struct({
    desktopBundle: pathText,
    bundleID: shortText,
    version: shortText,
    cliPath: pathText,
    cliVersion: shortText,
    workspace: pathText,
    effectiveStateHome: pathText,
    serviceRegistrationPath: pathText,
  }),
  service: Schema.Struct({
    process: NativeProcessIdentity,
    id: shortText,
    version: shortText,
    url: shortText,
  }),
  desktop: NativeProcessIdentity,
})
export type NativeBinding = typeof NativeBinding.Type

export const NativeWindowReference = Schema.Struct({
  windowID: positiveInt,
  webContentsID: positiveInt,
  rendererPID: positiveInt,
  generation: positiveInt,
  visible: Schema.Boolean,
  focused: Schema.Boolean,
})
export type NativeWindowReference = typeof NativeWindowReference.Type

export const NativeElement = Schema.Struct({
  ref: shortText,
  role: shortText,
  tag: shortText,
  name: boundedText,
  text: boundedText,
  inputType: Schema.String.check(Schema.isMaxLength(40)),
  editable: Schema.Boolean,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})
export type NativeElement = typeof NativeElement.Type

export const NativeSnapshot = Schema.Struct({
  snapshotID: shortText,
  window: NativeWindowReference,
  capturedAt: Schema.Number,
  title: boundedText,
  text: Schema.String.check(Schema.isMaxLength(3_000)),
  elements: Schema.Array(NativeElement).check(Schema.isMaxLength(100)),
  truncated: Schema.Boolean,
})
export type NativeSnapshot = typeof NativeSnapshot.Type

const Windowed = { window: NativeWindowReference }
export const NativeOperation = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["snapshot"]), ...Windowed }),
  Schema.Struct({ kind: Schema.Literals(["capture"]), ...Windowed }),
  Schema.Struct({
    kind: Schema.Literals(["click"]),
    ...Windowed,
    snapshotID: shortText,
    elementRef: shortText,
  }),
  Schema.Struct({
    kind: Schema.Literals(["type"]),
    ...Windowed,
    snapshotID: shortText,
    elementRef: shortText,
    text: Schema.String.check(Schema.isBetweenLength(1, 2_000)),
  }),
  Schema.Struct({
    kind: Schema.Literals(["key"]),
    ...Windowed,
    snapshotID: shortText,
    key: Schema.Literals(["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown"]),
  }),
])
export type NativeOperation = typeof NativeOperation.Type

export const NativeActionResult = Schema.Struct({
  delivery: Schema.Literals(["not-delivered", "delivered", "ambiguous"]),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  snapshot: Schema.optionalKey(NativeSnapshot),
  screenshotBase64: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000_000))),
})
export type NativeActionResult = typeof NativeActionResult.Type

const NativeCommand = Schema.Struct({
  requestID: shortText,
  operation: NativeOperation,
})

const NativeState = Schema.Literals(["queued", "delivered", "completed", "unknown"])
const NativeResultState = Schema.Struct({
  state: NativeState,
  result: Schema.optionalKey(NativeActionResult),
})

export const NativeInteraction = Rpc.define({
  id: "lazers.verification.native",
  events: {},
  methods: {
    attach: {
      input: portable(
        Schema.Struct({
          binding: NativeBinding,
          adapterID: shortText,
          windows: Schema.Array(NativeWindowReference).check(Schema.isMaxLength(32)),
        }),
      ),
      output: empty,
    },
    status: {
      input: portable(Schema.Struct({ binding: NativeBinding })),
      output: portable(
        Schema.Struct({
          ready: Schema.Boolean,
          blocked: Schema.Boolean,
          windows: Schema.Array(NativeWindowReference).check(Schema.isMaxLength(32)),
          adapterID: Schema.optionalKey(shortText),
        }),
      ),
    },
    enqueue: {
      input: portable(
        Schema.Struct({
          binding: NativeBinding,
          requestID: shortText,
          operation: NativeOperation,
        }),
      ),
      output: portable(Schema.Struct({ state: Schema.Literals(["queued", "existing"]) })),
    },
    poll: {
      input: portable(
        Schema.Struct({
          binding: NativeBinding,
          adapterID: shortText,
          windows: Schema.Array(NativeWindowReference).check(Schema.isMaxLength(32)),
        }),
      ),
      output: portable(Schema.NullOr(NativeCommand)),
    },
    complete: {
      input: portable(
        Schema.Struct({
          binding: NativeBinding,
          adapterID: shortText,
          requestID: shortText,
          result: NativeActionResult,
        }),
      ),
      output: empty,
    },
    result: {
      input: portable(Schema.Struct({ binding: NativeBinding, requestID: shortText })),
      output: portable(NativeResultState),
    },
    detach: {
      input: portable(Schema.Struct({ binding: NativeBinding, adapterID: shortText })),
      output: empty,
    },
  },
})
