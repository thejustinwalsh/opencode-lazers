import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"
import type { InferenceTraceEvent } from "./inference-trace.ts"

const traceID = Schema.String.check(Schema.isBetweenLength(1, 100))
const traceCount = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 10_000_000 }),
)
const traceTime = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 86_400_000 }),
)
const traceBytes = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 1_000_000_000_000 }),
)
const traceShape = Schema.Array(
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 })),
).check(Schema.isBetweenLength(0, 8))
const captureID = Schema.String.check(Schema.isBetweenLength(1, 100))
const captureText = Schema.String.check(Schema.isBetweenLength(0, 2_048))
const capturePath = Schema.String.check(Schema.isBetweenLength(0, 4_096))
const captureCount = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 10_000 }),
)
const captureTimestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
const leaseID = Schema.String.check(Schema.isBetweenLength(1, 100))
const leaseSequence = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
)
const LeaseIdentity = Schema.Struct({
  owner: leaseID,
  generationID: leaseID,
  generationSequence: leaseSequence,
  operationID: leaseID,
  providerEpoch: leaseID,
})
const LeasePredecessor = Schema.Struct({
  ...LeaseIdentity.fields,
  retirementID: leaseID,
  rendererDisposalID: leaseID,
})
const LeaseRetirement = Schema.Struct({
  windowID: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  retirementID: leaseID,
  generationID: leaseID,
  generationSequence: leaseSequence,
  operationID: leaseID,
  providerEpoch: leaseID,
  rendererDisposalID: leaseID,
})
const LeaseGrant = Schema.Struct({
  ...LeaseIdentity.fields,
  retired: Schema.optionalKey(LeaseRetirement),
})
const LeaseAcquire = Schema.Struct({
  generationID: leaseID,
  generationSequence: leaseSequence,
  operationID: leaseID,
  providerEpoch: leaseID,
  predecessor: Schema.optionalKey(LeasePredecessor),
})
const LeaseRelease = Schema.Struct({
  lease: LeaseIdentity,
  retirementID: leaseID,
  rendererDisposalID: leaseID,
})
export type ModelLeaseIdentity = typeof LeaseIdentity.Type
export type ModelLeaseGrant = typeof LeaseGrant.Type
export type ModelLeaseAcquire = typeof LeaseAcquire.Type
export type ModelLeaseRetirement = typeof LeaseRetirement.Type
const ProfilerCommand = Schema.Struct({
  method: Schema.Literals([
    "Profiler.enable",
    "Profiler.setSamplingInterval",
    "Profiler.start",
    "Profiler.stop",
  ]),
  outcome: Schema.Literals(["succeeded", "failed", "timed-out", "aborted"]),
  startedAt: captureTimestamp,
  settledAt: captureTimestamp,
  nativePending: Schema.optionalKey(Schema.Boolean),
  nativeOutcome: Schema.optionalKey(Schema.Literals(["succeeded", "failed"])),
  nativeSettledAt: Schema.optionalKey(captureTimestamp),
  profilerStateUncertain: Schema.optionalKey(Schema.Boolean),
})
const ProfilerCleanup = Schema.Struct({
  outcome: Schema.Literals(["detached", "not-required", "not-owned", "failed"]),
  startedAt: captureTimestamp,
  settledAt: captureTimestamp,
})
const TraceError = Schema.Struct({
  kind: Schema.Literals(["cancelled", "context-overflow", "device-lost", "deadline", "unknown"]),
  name: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, 80))),
  requiredTokens: Schema.optionalKey(traceCount),
  capacityTokens: Schema.optionalKey(traceCount),
})
export const InferenceTrace = Schema.Struct({
  requestID: traceID,
  jobID: Schema.optionalKey(traceID),
  mode: Schema.optionalKey(Schema.Literals(["text", "transcribe", "speak", "systemone"])),
  feature: Schema.optionalKey(
    Schema.Literals(["questions", "decisions", "review", "dictation", "readAloud"]),
  ),
  stage: Schema.Literals([
    "queued",
    "polled",
    "loading",
    "tokenize",
    "inputs-ready",
    "session-create",
    "session-ready",
    "prefill",
    "run",
    "generate",
    "readback",
    "dispose",
    "renderer-lag",
    "complete",
    "cancelled",
    "context-overflow",
    "device-lost",
    "error",
  ]),
  elapsedMs: traceTime,
  deltaMs: traceTime,
  queueDepth: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  ),
  active: Schema.optionalKey(Schema.Boolean),
  configuredEP: Schema.Literals(["webgpu", "wasm", "unknown"]),
  observedEP: Schema.Literals(["webgpu", "wasm", "unknown"]),
  contextCapacityTokens: Schema.optionalKey(traceCount),
  configuredMaxTokens: Schema.optionalKey(traceCount),
  inputChars: Schema.optionalKey(traceCount),
  questionCount: Schema.optionalKey(traceCount),
  actualInputTokens: Schema.optionalKey(traceCount),
  outputGeneratedTokens: Schema.optionalKey(traceCount),
  rendererLagMs: Schema.optionalKey(traceTime),
  jsHeapBytes: Schema.optionalKey(traceBytes),
  heapLimitBytes: Schema.optionalKey(traceBytes),
  inputShape: Schema.optionalKey(traceShape),
  outputShape: Schema.optionalKey(traceShape),
  error: Schema.optionalKey(TraceError),
})
export type InferenceTrace = InferenceTraceEvent

export const RendererCaptureStatus = Schema.Struct({
  state: Schema.Literals(["idle", "preparing", "waiting", "recording", "stopping", "complete"]),
  message: captureText,
  captureID: Schema.optionalKey(captureID),
  lastStage: Schema.optionalKey(captureText),
  lastRequestID: Schema.optionalKey(captureID),
  lastJobID: Schema.optionalKey(captureID),
  stageCount: captureCount,
  stageHistoryDropped: Schema.optionalKey(captureCount),
  captured: Schema.optionalKey(Schema.Boolean),
  reason: Schema.optionalKey(
    Schema.Literals([
      "devtools-open",
      "debugger-attached",
      "profiler-command-pending",
      "profiler-state-uncertain",
      "unavailable",
      "timeout",
      "aborted",
      "error",
      "profile-empty",
      "profile-too-large",
      "profile-invalid",
      "job-not-seen",
      "job-started-during-arming",
      "manual-stop-before-job",
      "lifecycle-lost",
      "cleanup-failed",
    ]),
  ),
  failure: Schema.optionalKey(
    Schema.Literals([
      "attach",
      "profiler-enable",
      "profiler-sampling",
      "profiler-start",
      "profiler-stop",
      "job-wait",
      "lifecycle",
      "profile",
      "profiler-cleanup",
    ]),
  ),
  path: Schema.optionalKey(capturePath),
  profilePath: Schema.optionalKey(capturePath),
  persistenceFailure: Schema.optionalKey(Schema.Literals(["late-metadata-update"])),
  stopTrigger: Schema.optionalKey(
    Schema.Literals([
      "terminal",
      "manual-stop",
      "manual-disarm",
      "next-job-timeout",
      "recording-timeout",
      "unresponsive",
      "preparation-race",
      "lifecycle-loss",
      "cleanup",
      "arming-failure",
    ]),
  ),
  outcome: Schema.optionalKey(Schema.Literals(["captured", "failed"])),
  triggeredAt: Schema.optionalKey(captureTimestamp),
  profilerCommands: Schema.optionalKey(
    Schema.Array(ProfilerCommand).check(Schema.isBetweenLength(0, 4)),
  ),
  profilerCleanup: Schema.optionalKey(ProfilerCleanup),
})
export type RendererCaptureStatus = typeof RendererCaptureStatus.Type

export const CacheStatus = Schema.Struct({
  phase: Schema.String,
  cachedBytes: Schema.Number,
  totalBytes: Schema.Number,
  downloadedBytes: Schema.Number,
  directory: Schema.String,
  error: Schema.String,
  occupied: Schema.Boolean,
})
export const ModelFiles = Ipc.define({
  id: "lazers.webgpu-files",
  methods: {
    identity: {
      output: Schema.Struct({
        providerEpoch: leaseID,
        windowID: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
      }),
    },
    registerGeneration: {
      input: Schema.Struct({ generationID: leaseID, generationSequence: leaseSequence }),
    },
    status: { output: CacheStatus },
    decisionStatus: { output: CacheStatus },
    acquire: { input: LeaseAcquire, output: LeaseGrant },
    reconcileAcquire: {
      input: Schema.Struct({
        generationID: leaseID,
        operationID: leaseID,
        providerEpoch: leaseID,
      }),
      output: Schema.Struct({ lease: Schema.NullOr(LeaseGrant) }),
    },
    ensure: { input: LeaseIdentity },
    decisionEnsure: { input: LeaseIdentity },
    decisionRead: {
      input: Schema.Struct({
        ...LeaseIdentity.fields,
        id: Schema.String,
        offset: Schema.Number,
        length: Schema.Number,
      }),
      output: Schema.String,
    },
    read: {
      input: Schema.Struct({
        ...LeaseIdentity.fields,
        id: Schema.String,
        offset: Schema.Number,
        length: Schema.Number,
      }),
      output: Schema.String,
    },
    release: { input: LeaseRelease, output: LeaseRetirement },
    reconcileRelease: {
      input: LeaseRelease,
      output: Schema.Struct({ retirement: Schema.NullOr(LeaseRetirement) }),
    },
    cancel: { input: LeaseIdentity },
    trace: { input: InferenceTrace },
    rendererCaptureStatus: { output: RendererCaptureStatus },
    armRendererCapture: { output: RendererCaptureStatus },
    stopRendererCapture: { output: RendererCaptureStatus },
    clear: {},
  },
})
