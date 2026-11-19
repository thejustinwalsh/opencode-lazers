import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"
import { AudioObservationEvent } from "./audio-fixture-contract.ts"

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

const NATIVE_BARE_KEYS = ["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown"] as const
export const NATIVE_KEYS = [...NATIVE_BARE_KEYS, "Ctrl+T"] as const
const NativeKey = Schema.Literals(NATIVE_KEYS)
export type NativeKey = typeof NativeKey.Type

export function parseNativeKey(value: unknown): NativeKey | undefined {
  try {
    return Schema.decodeUnknownSync(NativeKey)(value)
  } catch {
    return undefined
  }
}

export function nativeKeyUsesModifiers(key: NativeKey): boolean {
  return key === "Ctrl+T"
}

const NativeProcessIdentity = Schema.Struct({
  pid: positiveInt,
  startedAt: shortText,
  command: pathText,
})

export const NATIVE_VERIFICATION_BASE_ENV = "OPENCODE_LAZERS_VERIFICATION_BASE"

const NativeCandidateIdentity = Schema.Struct({
  workspace: pathText,
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  dirtyPaths: stringList,
  pluginEntry: pathText,
  guiEntry: pathText,
  guiEntryBytes: nonnegativeInt,
  guiEntryModifiedAt: shortText,
  architectDescription: boundedText,
})

const NativeBinding = Schema.Struct({
  ownerID: shortText,
  createdAt: shortText,
  root: pathText,
  verificationBase: pathText,
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

const NativeWindowReference = Schema.Struct({
  windowID: positiveInt,
  webContentsID: positiveInt,
  rendererPID: positiveInt,
  generation: positiveInt,
  visible: Schema.Boolean,
  focused: Schema.Boolean,
})
export type NativeWindowReference = typeof NativeWindowReference.Type

const NativeInteractionCapabilities = Schema.Struct({
  modifiedKeys: Schema.Boolean,
})
export type NativeInteractionCapabilities = typeof NativeInteractionCapabilities.Type

const NativeElement = Schema.Struct({
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

const NativeSnapshot = Schema.Struct({
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
const NativeOperation = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["snapshot"]), ...Windowed }),
  Schema.Struct({ kind: Schema.Literals(["capture"]), ...Windowed }),
  Schema.Struct({ kind: Schema.Literals(["focus"]), ...Windowed }),
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
    key: NativeKey,
  }),
  Schema.Struct({
    kind: Schema.Literals(["dictation-fixture"]),
    ...Windowed,
    sessionID: shortText,
    fixtureID: Schema.Literals(["quick-brown-fox", "turn-left-next-street"]),
  }),
  Schema.Struct({
    kind: Schema.Literals(["playback-plan"]),
    ...Windowed,
    sessionID: shortText,
    expectedTextHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    segmentHashes: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))).check(
      Schema.isBetweenLength(1, 32),
    ),
  }),
])
export type NativeOperation = typeof NativeOperation.Type

const NativeActionResult = Schema.Struct({
  delivery: Schema.Literals(["not-delivered", "delivered", "ambiguous"]),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  snapshot: Schema.optionalKey(NativeSnapshot),
  screenshotBase64: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000_000))),
})
export type NativeActionResult = typeof NativeActionResult.Type

const NativeAudioObservation = Schema.Struct({
  requestID: shortText,
  sessionID: shortText,
  window: NativeWindowReference,
  event: AudioObservationEvent,
})
const NativeAudioRecord = Schema.Struct({
  requestID: shortText,
  sessionID: shortText,
  window: NativeWindowReference,
  kind: Schema.Literals(["dictation", "playback"]),
  fixtureID: Schema.optionalKey(Schema.Literals(["quick-brown-fox", "turn-left-next-street"])),
  route: Schema.optionalKey(Schema.Literals(["runntime"])),
  expectedTextHash: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  segmentHashes: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))).check(
      Schema.isBetweenLength(1, 32),
    ),
  ),
  events: Schema.Array(Schema.Struct({ at: Schema.Number, event: AudioObservationEvent })).check(
    Schema.isMaxLength(100),
  ),
  appCompleted: Schema.Boolean,
  intelligibility: Schema.optionalKey(Schema.Literals(["pass", "fail", "unknown"])),
})

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
          capabilities: Schema.optionalKey(NativeInteractionCapabilities),
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
          capabilities: Schema.optionalKey(NativeInteractionCapabilities),
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
      output: portable(
        Schema.Struct({ state: Schema.Literals(["queued", "existing", "completed"]) }),
      ),
    },
    poll: {
      input: portable(
        Schema.Struct({
          binding: NativeBinding,
          adapterID: shortText,
          windows: Schema.Array(NativeWindowReference).check(Schema.isMaxLength(32)),
          capabilities: Schema.optionalKey(NativeInteractionCapabilities),
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
    audioObserve: {
      input: portable(
        Schema.Struct({
          binding: NativeBinding,
          adapterID: shortText,
          observation: NativeAudioObservation,
        }),
      ),
      output: empty,
    },
    audioResult: {
      input: portable(Schema.Struct({ binding: NativeBinding, requestID: shortText })),
      output: portable(Schema.NullOr(NativeAudioRecord)),
    },
    detach: {
      input: portable(Schema.Struct({ binding: NativeBinding, adapterID: shortText })),
      output: empty,
    },
  },
})
