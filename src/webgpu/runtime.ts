import { createEffect, createSignal } from "solid-js"
import type { Plugin } from "@opencode/plugin/gui"
import { ModelFiles } from "./ipc.ts"
import {
  MODEL_BYTES,
  DECISION_BYTES,
  DECISION_FILES,
  DECISION_REPOSITORY,
  DECISION_REVISION,
  LFM3_TOKENIZER_REVISION,
  MODEL_FILES,
  MODEL_REPOSITORY,
  MODEL_REVISION,
  RUNNTIME_REVISION,
} from "./manifest.ts"
import {
  GENERATION_RESULT_CONTRACT_REVISION,
  OMNI_REQUEST_TIMEOUT_MS,
  LocalInference,
  RendererInference,
  isRendererOwnershipLost,
} from "./rpc.ts"
import type { InferenceJob } from "./rpc.ts"
import type { DecisionInput } from "./decisions.ts"
import { failed } from "./broker.ts"
import { decodePCM16, wavBase64 } from "./audio.ts"
import { loadDecisionRuntime, type DecisionRuntime } from "./runntime-decision-runtime.ts"
import type { SystemOneInput } from "./system-one.ts"
import { ExclusiveModels, retryLoad } from "./lifecycle.ts"
import { DEFAULT_VOICE, runntimeSpeechVoice } from "./speech.ts"
import type { SpeechVoice } from "./speech.ts"
import { DEFAULT_MODEL_KEEP_ALIVE_MS, featureEnabled, usesGPU, needsChat } from "./features.ts"
import type { Features, LocalFeature } from "./features.ts"
import { loadRunntimeOmni } from "./runntime-adapter.ts"
import { modelKindForInference } from "./inference-route.ts"
import type { ChatRoute, ModelKind } from "./inference-route.ts"

import type { InferenceTraceEvent, InferenceTraceMark, TraceStage } from "./inference-trace.ts"
import { RuntimeTrace } from "./runtime-trace.ts"
import type {
  ModelLeaseAcquire,
  ModelLeaseGrant,
  ModelLeaseIdentity,
  ModelLeaseRetirement,
} from "./ipc.ts"

class WorkerDetachError extends Error {}

type HandoffGeneration = {
  generationID: string
  generationSequence: number
  previous?: string
  state: "active" | "disposing" | "disposed" | "failed"
  disposalID?: string
  acquire?: ModelLeaseAcquire
  grant?: ModelLeaseGrant
  retiredBy?: ModelLeaseRetirement
  release?: {
    lease: ModelLeaseIdentity
    retirementID: string
    rendererDisposalID: string
  }
  releaseAck?: ModelLeaseRetirement
}

type HandoffMemory = {
  sequence: number
  current?: string
  providerEpoch?: string
  windowID?: number
  generations: Record<string, HandoffGeneration>
}

const leaseIdentity = (grant: ModelLeaseGrant): ModelLeaseIdentity => ({
  owner: grant.owner,
  generationID: grant.generationID,
  generationSequence: grant.generationSequence,
  operationID: grant.operationID,
  providerEpoch: grant.providerEpoch,
})

const matchesRetirement = (
  ack: ModelLeaseRetirement | undefined,
  windowID: number,
  lease: ModelLeaseIdentity,
  retirementID: string,
  rendererDisposalID: string,
) =>
  ack?.windowID === windowID &&
  ack?.retirementID === retirementID &&
  ack.generationID === lease.generationID &&
  ack.generationSequence === lease.generationSequence &&
  ack.operationID === lease.operationID &&
  ack.providerEpoch === lease.providerEpoch &&
  ack.rendererDisposalID === rendererDisposalID

// Native RPC failures are structured values, not necessarily Error instances.
const errorDetail = (error: unknown): string => {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const type = "type" in error && typeof error.type === "string" ? `${error.type}: ` : ""
    return `${type}${error.message}`.slice(0, 2_000)
  }
  return String(error).slice(0, 2_000)
}

const artifactIdentity = (
  files: readonly { name: string; sha256: string }[],
  extra: readonly string[] = [],
) => [...files.map(({ name, sha256 }) => `${name} sha256:${sha256}`), ...extra].join("; ")

const tokenizerIdentity = `LiquidAI/LFM3-Omni-2B tokenizer.json revision:${LFM3_TOKENIZER_REVISION}`

export function createInferenceRuntime(
  ctx: Parameters<Plugin.Setup>[0],
  /** Undefined means the preference has not hydrated: neither unload nor pin the model. */
  keepAliveMs: () => number | undefined = () => DEFAULT_MODEL_KEEP_ALIVE_MS,
  voice: () => SpeechVoice = () => DEFAULT_VOICE,
  features: () => Features,
  timing: {
    now?: () => number
    wallNow?: () => number
    schedule?: (callback: () => void, delayMs: number) => () => void
    serviceTimeoutMs?: number
  } = {},
) {
  const files = ctx.main(ModelFiles)
  const supportsLeaseHandoff =
    typeof (files as unknown as { identity?: unknown }).identity === "function" &&
    typeof (files as unknown as { registerGeneration?: unknown }).registerGeneration === "function"
  let traceWrites = Promise.resolve()
  const writeTrace = (event: InferenceTraceEvent) => {
    traceWrites = traceWrites
      .then(async () => {
        await files.trace(event, { signal: AbortSignal.timeout(2_000) })
      })
      .catch(() => {})
  }
  const now = timing.now ?? (() => performance.now())
  const wallNow = timing.wallNow ?? Date.now
  const runtimeTrace = new RuntimeTrace(writeTrace, now)
  const audioRoute = () => "runntime" as const
  let activeInputTokens: number | undefined
  const traceStage = async (stage: TraceStage, metadata?: InferenceTraceMark) => {
    if (runtimeTrace.hasActiveRequest && metadata?.actualInputTokens !== undefined)
      activeInputTokens = metadata.actualInputTokens
    runtimeTrace.mark(stage, metadata)
    await traceWrites
  }
  const heap = () => {
    const memory = (
      performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
    ).memory
    return memory
      ? { jsHeapBytes: memory.usedJSHeapSize, heapLimitBytes: memory.jsHeapSizeLimit }
      : {}
  }
  const [state, setState] = createSignal("unloaded")
  const [detail, setDetail] = createSignal("Preparing local intelligence")
  const [gpu, setGPU] = createSignal("")
  const [phase, setPhase] = createSignal("unloaded")
  const [resident, setResidentValue] = createSignal<ModelKind | undefined>()
  const setResident = (kind: ModelKind | undefined) => {
    setResidentValue(kind)
  }
  const [contractStatus, setContractStatus] = createSignal<
    "unverified" | "checking" | "compatible" | "incompatible"
  >("unverified")
  const [contractError, setContractError] = createSignal("")
  const fallbackHandoff: HandoffMemory = { sequence: 0, generations: {} }
  let handoff: HandoffMemory
  let setHandoff: (update: (draft: HandoffMemory) => void) => void
  const storage = (ctx as unknown as { storage?: typeof ctx.storage }).storage
  if (typeof storage?.memory === "function") {
    ;[handoff, setHandoff] = storage.memory<HandoffMemory>("webgpu-model-lease", {
      initial: fallbackHandoff,
    })
  } else {
    handoff = fallbackHandoff
    setHandoff = (update) => update(fallbackHandoff)
  }
  if (!Number.isSafeInteger(handoff.sequence) || handoff.sequence >= Number.MAX_SAFE_INTEGER)
    throw new Error("Renderer generation sequence is exhausted")
  const generationID = crypto.randomUUID()
  const generationSequence = handoff.sequence + 1
  let previousGenerationID = handoff.current
  const prunedGenerations: string[] = []
  while (previousGenerationID) {
    const previous = handoff.generations[previousGenerationID]
    if (
      !previous ||
      previous.state !== "disposed" ||
      previous.grant ||
      previous.acquire ||
      previous.release
    )
      break
    prunedGenerations.push(previousGenerationID)
    previousGenerationID = previous.previous
  }
  if (Object.keys(handoff.generations).length - prunedGenerations.length >= 64)
    throw new Error("Renderer ownership history is full; previous ownership remains occupied")
  setHandoff((draft) => {
    for (const id of prunedGenerations) delete draft.generations[id]
    draft.sequence = generationSequence
    draft.current = generationID
    draft.generations[generationID] = {
      generationID,
      generationSequence,
      ...(previousGenerationID ? { previous: previousGenerationID } : {}),
      state: "active",
    }
  })
  const generation = () => handoff.generations[generationID]!
  const updateGeneration = (id: string, update: (entry: HandoffGeneration) => void) =>
    setHandoff((draft) => {
      const entry = draft.generations[id]
      if (entry) update(entry)
    })
  const models = new ExclusiveModels<{
    audio: Awaited<ReturnType<typeof loadRunntimeOmni>>
    decision: { engine: DecisionRuntime; dispose(): Promise<void> }
  }>()
  const transcripts = new Map<string, (text: string) => void>()
  let owner: ModelLeaseGrant | undefined
  let initializing: Promise<void> | undefined
  let loadController: AbortController | undefined
  let active:
    | { id: string; feature: LocalFeature; controller: AbortController; done: Promise<void> }
    | undefined
  let polling = false
  let pollDisconnected = false
  let attachPending = false
  let disposed = false
  let unloading: Promise<void> | undefined
  let switching = false
  let recovery: Promise<void> | undefined
  let recoveryController: AbortController | undefined
  let recoveryKind: ModelKind | undefined
  let lastUsed = wallNow()
  let autoload = false
  let losses: number[] = []
  let recoveryRetry: { kind: ModelKind; at: number } | undefined
  let nextLoadAttempt = 0
  let loadFailures = 0
  const serviceSignal = () =>
    AbortSignal.any([ctx.signal, AbortSignal.timeout(timing.serviceTimeoutMs ?? 5_000)])
  const rpc = () => ctx.client.rpc(LocalInference)
  const worker = () => ctx.client.rpc(RendererInference)
  const verifyCompletionContract = async (signal: AbortSignal) => {
    setContractStatus("checking")
    try {
      const contract = await worker().contract({}, { signal })
      if (contract.revision !== GENERATION_RESULT_CONTRACT_REVISION) {
        setContractStatus("incompatible")
        throw new Error(
          `Service reports ${contract.revision}; expected ${GENERATION_RESULT_CONTRACT_REVISION}`,
        )
      }
      setContractStatus("compatible")
      setContractError("")
    } catch (cause) {
      if (contractStatus() !== "incompatible") setContractStatus("unverified")
      const message =
        `Local inference completion contract could not be verified (expected ${GENERATION_RESULT_CONTRACT_REVISION}). ` +
        `The service/renderer pair may be incompatible or unavailable. Reload the OpenCode service and reopen Desktop before probing. ` +
        `Cause: ${errorDetail(cause)}`
      setContractError(message)
      throw new Error(message, { cause })
    }
  }
  const refreshResident = () => {
    setResident(models.current())
  }
  const ready = () => {
    refreshResident()
    if (models.isTainted()) {
      setState("error")
      setPhase("error")
      setDetail(
        "GPU cleanup failed; ownership is retained. Retry unloading before using local inference.",
      )
      return
    }
    if (!usesGPU(features())) {
      setState("disabled")
      setPhase("disabled")
      setDetail(
        features().enabled
          ? "All local inference features are turned off"
          : "Local inference is turned off; downloaded models are kept",
      )
      return
    }
    if (contractStatus() !== "compatible") {
      setState("error")
      setPhase("error")
      setDetail(
        contractError() ||
          "Local inference completion contract is not verified; reload the OpenCode service and reopen Desktop before probing.",
      )
      return
    }
    setState(models.current() ? "ready" : "unloaded")
    setPhase(models.current() ? "ready" : "unloaded")
    setDetail(
      models.current() === "decision"
        ? "d1 ready · chat and speech load on demand"
        : models.current() === "audio"
          ? "ruNNtime Omni ready · d1 loads on demand"
          : "Unloaded; the next request loads the cached model",
    )
  }
  const fail = (error: unknown) => {
    setState("error")
    setPhase("error")
    setDetail(errorDetail(error))
  }

  const ancestors = () => {
    const result: HandoffGeneration[] = []
    const seen = new Set<string>()
    let id = generation().previous
    while (id) {
      if (seen.has(id)) throw new Error("Renderer ownership history is invalid")
      seen.add(id)
      const entry = handoff.generations[id]
      if (!entry) throw new Error("Previous renderer ownership is unknown")
      result.push(entry)
      id = entry.previous
    }
    return result.reverse()
  }

  const pauseForHandoff = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      const abort = () => {
        clearTimeout(timer)
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort)
        resolve()
      }, 20)
      signal.addEventListener("abort", abort, { once: true })
    })

  const waitForRendererDisposal = async (previous: HandoffGeneration[], signal: AbortSignal) => {
    const deadline = Date.now() + 120_000
    while (true) {
      signal.throwIfAborted()
      const failedGeneration = previous.find((entry) => entry.state === "failed")
      if (failedGeneration)
        throw new Error(`Renderer ${failedGeneration.generationSequence} disposal is unconfirmed`)
      if (previous.every((entry) => entry.state === "disposed" && entry.disposalID)) return
      if (Date.now() >= deadline)
        throw new Error(
          "Previous renderer disposal is still unconfirmed; cache ownership is retained",
        )
      await pauseForHandoff(signal)
    }
  }

  const checkGrant = (grant: ModelLeaseGrant, request: ModelLeaseAcquire) => {
    if (
      grant.generationID !== request.generationID ||
      grant.generationSequence !== request.generationSequence ||
      grant.operationID !== request.operationID ||
      grant.providerEpoch !== request.providerEpoch
    )
      throw new Error("Main-process acquisition acknowledgement did not match its request")
    if (request.predecessor) {
      if (
        grant.owner !== request.predecessor.owner ||
        !matchesRetirement(
          grant.retired,
          handoff.windowID!,
          request.predecessor,
          request.predecessor.retirementID,
          request.predecessor.rendererDisposalID,
        )
      )
        throw new Error("Main-process retirement acknowledgement did not match its predecessor")
    } else if (grant.retired) throw new Error("Unexpected predecessor retirement acknowledgement")
  }

  const storeGrant = (entryID: string, grant: ModelLeaseGrant, request: ModelLeaseAcquire) => {
    checkGrant(grant, request)
    if (request.predecessor) {
      const predecessor = handoff.generations[request.predecessor.generationID]
      if (!predecessor) throw new Error("Retired renderer identity is unknown")
      updateGeneration(predecessor.generationID, (entry) => {
        entry.retiredBy = grant.retired
      })
    }
    updateGeneration(entryID, (entry) => {
      entry.grant = grant
    })
    if (entryID === generationID)
      setHandoff((draft) => {
        if (draft.current !== generationID) return
        const current = draft.generations[generationID]
        if (!current) return
        const predecessorID = request.predecessor?.generationID
        current.previous = predecessorID
        for (const id of Object.keys(draft.generations))
          if (id !== generationID && id !== predecessorID) delete draft.generations[id]
        if (predecessorID) {
          const predecessor = draft.generations[predecessorID]
          if (predecessor) {
            delete predecessor.previous
            delete predecessor.acquire
            delete predecessor.grant
            delete predecessor.release
            delete predecessor.releaseAck
          }
        }
      })
  }

  const reconcileAncestors = async (previous: HandoffGeneration[], signal: AbortSignal) => {
    for (const entry of previous) {
      if (entry.state === "failed")
        throw new Error(`Renderer ${entry.generationSequence} disposal is unconfirmed`)
      if (entry.acquire && !entry.grant) {
        try {
          const reconciled = await files.reconcileAcquire(
            {
              generationID: entry.acquire.generationID,
              operationID: entry.acquire.operationID,
              providerEpoch: entry.acquire.providerEpoch,
            },
            { signal },
          )
          if (reconciled.lease) storeGrant(entry.generationID, reconciled.lease, entry.acquire)
        } catch (error) {
          if (signal.aborted) throw error
          // Unknown or failed acquisition is not ownership evidence. A fresh exact handoff will
          // either find its predecessor or fail closed while the main process remains occupied.
        }
      }
      if (entry.release && !entry.releaseAck) {
        try {
          const reconciled = await files.reconcileRelease(entry.release, { signal })
          const ack = reconciled.retirement
          if (
            ack &&
            matchesRetirement(
              ack,
              handoff.windowID!,
              entry.release.lease,
              entry.release.retirementID,
              entry.release.rendererDisposalID,
            )
          )
            updateGeneration(entry.generationID, (current) => {
              current.releaseAck = ack
              current.retiredBy = ack
            })
        } catch (error) {
          if (signal.aborted) throw error
          // An unacknowledged release is not proof of a free cache; hand off its exact lease instead.
        }
      }
    }
  }

  const currentPredecessor = (previous: HandoffGeneration[]) => {
    let current: ModelLeaseGrant | undefined
    for (const entry of previous) {
      if (entry.grant) current = entry.grant
      const retired = entry.retiredBy ?? entry.releaseAck
      if (
        current &&
        retired &&
        matchesRetirement(
          retired,
          handoff.windowID!,
          leaseIdentity(current),
          retired.retirementID,
          retired.rendererDisposalID,
        )
      )
        current = undefined
    }
    return current
  }

  const acquireLease = async (signal: AbortSignal) => {
    if (owner) return owner
    if (!supportsLeaseHandoff) {
      const acquire = (
        files as unknown as { acquire: (options: { signal: AbortSignal }) => Promise<string> }
      ).acquire
      const token = await acquire({ signal })
      signal.throwIfAborted()
      owner = {
        owner: token,
        generationID,
        generationSequence,
        operationID: `legacy-${generationID}`,
        providerEpoch: "legacy",
      }
      return owner
    }
    const provider = await files.identity({ signal })
    if (handoff.windowID !== undefined && handoff.windowID !== provider.windowID)
      throw new Error("The renderer window changed; previous ownership remains unproven")
    const previous = ancestors()
    const providerChanged = Boolean(
      handoff.providerEpoch && handoff.providerEpoch !== provider.providerEpoch,
    )
    if (providerChanged) {
      // An idle provider owns no inherited lease. Intermediate idle generations
      // need no lease-epoch match; disposal and predecessor checks below still apply.
      if (
        provider.previousProviderState !== "idle" &&
        (provider.previousProviderEpoch !== handoff.providerEpoch ||
          !provider.previousProviderState ||
          provider.previousProviderState === "unproven")
      )
        throw new Error("The main-process provider changed without exact retirement evidence")
      if (provider.previousProviderState === "host-lost" && previous.length)
        throw new Error("Host document loss cannot reconcile partial renderer ownership memory")
    } else if (
      (!handoff.providerEpoch || handoff.windowID === undefined) &&
      previous.some((entry) => entry.grant || entry.acquire || entry.release)
    ) {
      throw new Error("Previous main-process ownership identity is missing")
    }
    await files.registerGeneration({ generationID, generationSequence }, { signal })
    await waitForRendererDisposal(previous, signal)
    await reconcileAncestors(previous, signal)
    const predecessor = currentPredecessor(previous)
    if (providerChanged) {
      if (provider.previousProviderState === "retired" && !predecessor)
        throw new Error("The replacement provider retains an unidentified predecessor")
      if (provider.previousProviderState === "idle" && predecessor)
        throw new Error("The replacement provider does not acknowledge previous ownership")
    }
    if (!handoff.providerEpoch || providerChanged || handoff.windowID === undefined)
      setHandoff((draft) => {
        draft.providerEpoch = provider.providerEpoch
        draft.windowID = provider.windowID
      })
    let request = generation().releaseAck ? undefined : generation().acquire
    if (!request) {
      if (predecessor) {
        const predecessorEntry = previous.find(
          (entry) => entry.generationID === predecessor.generationID,
        )
        if (
          !predecessorEntry ||
          predecessorEntry.state !== "disposed" ||
          !predecessorEntry.disposalID
        )
          throw new Error("Previous renderer disposal or provider ownership is unconfirmed")
        request = {
          generationID,
          generationSequence,
          operationID: crypto.randomUUID(),
          providerEpoch: provider.providerEpoch,
          predecessor: {
            ...leaseIdentity(predecessor),
            retirementID: crypto.randomUUID(),
            rendererDisposalID: predecessorEntry.disposalID,
          },
        }
      } else {
        request = {
          generationID,
          generationSequence,
          operationID: crypto.randomUUID(),
          providerEpoch: provider.providerEpoch,
        }
      }
      updateGeneration(generationID, (entry) => {
        entry.acquire = request
        delete entry.grant
        delete entry.retiredBy
        delete entry.release
        delete entry.releaseAck
      })
    }
    if (request.providerEpoch !== provider.providerEpoch)
      throw new Error("The main-process provider changed during renderer handoff")
    const grant = await files.acquire(request, { signal })
    signal.throwIfAborted()
    storeGrant(generationID, grant, request)
    owner = grant
    return grant
  }

  const retireLease = async (
    grant: ModelLeaseGrant,
    rendererDisposalID: string,
    signal: AbortSignal,
  ) => {
    if (!supportsLeaseHandoff) {
      const release = (
        files as unknown as {
          release: (input: { owner: string }, options: { signal: AbortSignal }) => Promise<void>
        }
      ).release
      await release({ owner: grant.owner }, { signal })
      if (owner === grant) owner = undefined
      return
    }
    let request = generation().release
    if (!request) {
      request = {
        lease: leaseIdentity(grant),
        retirementID: crypto.randomUUID(),
        rendererDisposalID,
      }
      updateGeneration(generationID, (entry) => {
        entry.release = request
      })
    }
    if (JSON.stringify(request.lease) !== JSON.stringify(leaseIdentity(grant)))
      throw new Error("Renderer retirement identity changed during cleanup")
    const ack = await files.release(request, { signal })
    if (
      !matchesRetirement(
        ack,
        handoff.windowID!,
        request.lease,
        request.retirementID,
        request.rendererDisposalID,
      )
    )
      throw new Error("Main-process cleanup acknowledgement did not match its request")
    updateGeneration(generationID, (entry) => {
      entry.releaseAck = ack
      entry.retiredBy = ack
    })
    if (owner && JSON.stringify(leaseIdentity(owner)) === JSON.stringify(request.lease))
      owner = undefined
    return ack
  }

  const detachWorker = async (lease: ModelLeaseGrant, error?: unknown) => {
    if (supportsLeaseHandoff && ctx.signal.aborted) return false
    try {
      await worker().detach(
        {
          owner: lease.owner,
          ...(error === undefined ? {} : { error: errorDetail(error) }),
        },
        { signal: serviceSignal() },
      )
      attachPending = false
      return true
    } catch (cause) {
      if (supportsLeaseHandoff && ctx.signal.aborted) return false
      attachPending = true
      throw new WorkerDetachError(
        `Local inference worker detach failed; cache ownership is retained: ${errorDetail(cause)}`,
      )
    }
  }

  const reportCompletionDeliveryFailure = async (token: string, cause: unknown) => {
    setContractStatus("unverified")
    const message =
      `Local inference completion delivery failed: ${errorDetail(cause)}. ` +
      `The renderer/service pairing is not ready for qualification; reload the OpenCode service and reopen Desktop before probing.`
    setContractError(message)
    fail(message)
    try {
      await worker().detach({ owner: token, error: message }, { signal: serviceSignal() })
      attachPending = false
    } catch (detachError) {
      setDetail(`${message} Mailbox failure notification also failed: ${errorDetail(detachError)}`)
    }
    return message
  }

  const cancelLease = () => {
    if (!owner) return
    const cancel = supportsLeaseHandoff
      ? files.cancel(leaseIdentity(owner))
      : (
          files as unknown as {
            cancel(input: { owner: string }): Promise<void>
          }
        ).cancel({ owner: owner.owner })
    void cancel.catch(() => {})
  }

  const ensureModel = async (kind: ModelKind, signal: AbortSignal) => {
    const requestedSignal = signal
    signal = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    if (
      (kind === "audio" && !needsChat(features())) ||
      (kind === "decision" && !featureEnabled(features(), "decisions"))
    )
      throw Error("This model's local features are turned off")
    if (models.get(kind)) {
      setResident(models.current())
      return
    }
    const lease = owner
    if (!lease) {
      const error = new Error("Local model cache ownership was lost")
      fail(error)
      throw error
    }
    const readModelFile = (id: string, offset: number, length: number, readSignal: AbortSignal) => {
      if (!supportsLeaseHandoff)
        return (
          files as unknown as {
            read(
              input: { owner: string; id: string; offset: number; length: number },
              options: { signal: AbortSignal },
            ): Promise<string>
          }
        ).read({ owner: lease.owner, id, offset, length }, { signal: readSignal })
      return files.read({ ...leaseIdentity(lease), id, offset, length }, { signal: readSignal })
    }
    switching = true
    setState("loading")
    setPhase("loading")
    setResident(models.current())
    setDetail(
      kind === "decision"
        ? "Loading d1 decision model from cache"
        : "Loading ruNNtime Omni from verified cache",
    )
    try {
      if (!usesGPU(features())) throw Error("Local inference is turned off")
      if (supportsLeaseHandoff) {
        if (kind !== "decision") await files.ensure(leaseIdentity(lease), { signal })
        else await files.decisionEnsure(leaseIdentity(lease), { signal })
      } else {
        const legacy = files as unknown as {
          ensure(input: { owner: string }, options: { signal: AbortSignal }): Promise<void>
          decisionEnsure(input: { owner: string }, options: { signal: AbortSignal }): Promise<void>
        }
        if (kind !== "decision") await legacy.ensure({ owner: lease.owner }, { signal })
        else await legacy.decisionEnsure({ owner: lease.owner }, { signal })
      }
      if (models.current() && (models.current() !== kind || models.isTainted())) {
        await models.release()
        setResident(models.current())
      }
      if (kind === "audio") {
        const loaded = await models.ensure(
          "audio",
          () =>
            retryLoad(
              async () => {
                await traceStage("session-create")
                const model = await loadRunntimeOmni({
                  read: (id, offset, length, readSignal) =>
                    readModelFile(id, offset, length, readSignal ?? signal),
                  signal,
                  onProgress: (name, done, total) =>
                    setDetail(
                      `Loading ruNNtime Omni audio · ${name} · ${Math.floor((done / total) * 100)}%`,
                    ),
                })
                await traceStage("session-ready")
                let intentional = false
                void model.lost.then(() => {
                  if (!intentional && !disposed && !unloading) recover("audio")
                })
                return {
                  ...model,
                  dispose: async () => {
                    intentional = true
                    await model.dispose()
                  },
                }
              },
              signal,
              setDetail,
            ),
          signal,
        )
        void loaded
        setGPU("WebGPU · ruNNtime TypeGPU · shader-f16")
      } else {
        await models.ensure(
          "decision",
          () =>
            retryLoad(
              async () => {
                const engine = await loadDecisionRuntime(
                  (id, offset, length, readSignal = signal) => {
                    if (!supportsLeaseHandoff)
                      return (
                        files as unknown as {
                          decisionRead(
                            input: { owner: string; id: string; offset: number; length: number },
                            options: { signal: AbortSignal },
                          ): Promise<string>
                        }
                      ).decisionRead(
                        { owner: lease.owner, id, offset, length },
                        { signal: readSignal },
                      )
                    return files.decisionRead(
                      { ...leaseIdentity(lease), id, offset, length },
                      { signal: readSignal },
                    )
                  },
                  signal,
                  setDetail,
                  () => {
                    runtimeTrace.mark("device-lost")
                    if (!disposed && !unloading) recover("decision")
                  },
                  traceStage,
                )
                return { engine, dispose: () => engine.dispose() }
              },
              signal,
              setDetail,
            ),
          signal,
        )
        setGPU("WebGPU · ruNNtime d1 Omni 600M Q8")
      }
      signal.throwIfAborted()
      setResident(models.current())
      lastUsed = wallNow()
      manualUnload = false
    } catch (error) {
      setResident(models.current())
      if (requestedSignal.aborted) {
        if (!unloading && !disposed) ready()
      } else fail(error)
      throw error
    } finally {
      switching = false
    }
  }

  let decisionExecuting = false
  const recover = (kind: ModelKind) => {
    if (recovery || disposed || unloading) return
    const waitForDemand = kind === "decision" && decisionExecuting
    setState("loading")
    setPhase("loading")
    losses = losses.filter((time) => wallNow() - time < 60_000)
    losses.push(wallNow())
    recoveryController = new AbortController()
    recoveryKind = kind
    const recoverySignal = AbortSignal.any([
      ctx.signal,
      recoveryController.signal,
      AbortSignal.timeout(120_000),
    ])
    active?.controller.abort(new Error("GPU device was lost; this request was not replayed"))
    recovery = (async () => {
      try {
        await active?.done
        await models.release()
        setResident(models.current())
        if (disposed || unloading) return
        if (waitForDemand) {
          // A failed decision may have exhausted GPU memory. Release its device
          // now and let the next queued job choose and load its model.
          setGPU("")
          ready()
          return
        }
        if (losses.length > 2) {
          recoveryRetry = { kind, at: wallNow() + 60_000 }
          throw new Error(
            "Repeated GPU loss; automatic recovery is cooling down for one minute. A new request can try sooner.",
          )
        }
        setDetail("GPU device lost; recovering from verified disk cache")
        await ensureModel(kind, recoverySignal)
        ready()
      } catch (error) {
        fail(error)
      } finally {
        recovery = undefined
        recoveryController = undefined
        recoveryKind = undefined
      }
    })()
  }

  const run = async (job: InferenceJob, token: string, controller: AbortController) => {
    const inferenceKind = modelKindForInference(job.mode)
    const systemOne = inferenceKind === "decision"
    const backend = systemOne ? "d1" : "runntime"
    const modelArtifacts = artifactIdentity(
      systemOne ? DECISION_FILES : MODEL_FILES,
      systemOne ? [] : [tokenizerIdentity],
    )
    const trace = runtimeTrace.begin({
      requestID: job.requestID,
      jobID: job.id,
      mode: job.mode,
      feature: job.feature,
      configuredEP: "webgpu",
      observedEP: "webgpu",
      backend,
      modelRepository: systemOne ? DECISION_REPOSITORY : MODEL_REPOSITORY,
      modelRevision: systemOne ? DECISION_REVISION : MODEL_REVISION,
      modelPrecision: systemOne ? "Q8" : "language Q4_K_M + projector Q8_0",
      modelArtifacts,
      runtimeRevision: RUNNTIME_REVISION,
      contextCapacityTokens: systemOne ? 16_384 : 4_096,
      configuredMaxTokens: job.maxTokens,
    })
    activeInputTokens = undefined
    let streamedText = ""
    const deliverText = async (text: string) => {
      if (!text) return
      controller.signal.throwIfAborted()
      if (!job.streaming) {
        transcripts.get(job.requestID)?.(text)
        return
      }
      streamedText += text
      for (let offset = 0; offset < text.length; offset += 8_000) {
        const { accepted } = await worker().delta(
          { owner: token, id: job.id, text: text.slice(offset, offset + 8_000) },
          { signal: AbortSignal.any([controller.signal, serviceSignal()]) },
        )
        if (!accepted)
          throw new Error("Native conversation stream was cancelled or lost renderer ownership")
        controller.signal.throwIfAborted()
      }
    }
    trace.mark("polled", { active: true, inputChars: job.prompt.length, ...heap() })
    await traceWrites
    const deadline = setTimeout(
      () =>
        controller.abort(
          Object.assign(new Error("Local inference deadline exceeded"), { name: "TimeoutError" }),
        ),
      job.timeoutMs,
    )
    let result = failed("Generation did not complete")
    let failure: unknown
    try {
      if (!featureEnabled(features(), job.feature))
        throw Error("This local inference feature is turned off")
      recoveryRetry = undefined
      await traceStage("loading")
      await ensureModel(inferenceKind, controller.signal)
      setState("busy")
      setPhase("busy")
      setDetail(
        job.mode === "systemone"
          ? "Evaluating decision questions locally"
          : job.mode === "transcribe"
            ? "Transcribing locally"
            : job.mode === "speak"
              ? "Generating speech locally"
              : "Generating locally",
      )
      if (systemOne) {
        const input = JSON.parse(job.prompt)
        const engine = models.get("decision")!.engine
        decisionExecuting = true
        const output = await engine.systemOne(input, controller.signal, traceStage).finally(() => {
          decisionExecuting = false
        })
        result = {
          ok: true,
          text: JSON.stringify(output),
          error: "",
          promptTokens: output.usage.input_tokens,
          completionTokens: 0,
        }
      } else if (inferenceKind === "audio" && job.mode !== "text") {
        const engine = models.get("audio")!.engine
        await traceStage("session-create")
        await traceStage("session-ready")
        await traceStage("generate", heap())
        if (job.mode === "transcribe") {
          const text = await engine.transcribe(decodePCM16(job.audioBase64), {
            maxNewTokens: job.maxTokens,
            signal: controller.signal,
          })
          controller.signal.throwIfAborted()
          if (text) await deliverText(text)
          result = { ok: true, text, error: "", promptTokens: null, completionTokens: null }
        } else {
          const generation = engine.speak(job.prompt, {
            temperature: 0.4,
            maxAudioFrames: 256,
            voice: runntimeSpeechVoice(job.voice),
            signal: controller.signal,
          })
          for await (const _chunk of generation) controller.signal.throwIfAborted()
          const output = await generation.result
          controller.signal.throwIfAborted()
          if (output.finishReason === "length")
            throw new Error("Speech segment exceeded the audio frame budget; use shorter text")
          result = {
            ok: true,
            text: job.prompt,
            error: "",
            promptTokens: null,
            completionTokens: null,
            audioBase64: wavBase64(output.samples, output.sampleRate),
          }
        }
      } else {
        const engine = models.get("audio")!.engine
        if (!("generate" in engine)) throw Error("ruNNtime chat route is unavailable")
        await traceStage("session-create")
        await traceStage("session-ready")
        await traceStage("generate", heap())
        const generation = engine.generate(
          job.messages ?? [{ role: "user", content: job.prompt }],
          {
            maxNewTokens: job.maxTokens,
            signal: controller.signal,
          },
        )
        for await (const text of generation) {
          controller.signal.throwIfAborted()
          await deliverText(text)
        }
        const output = await generation.result
        controller.signal.throwIfAborted()
        if (job.streaming && streamedText !== output.text)
          throw new Error("ruNNtime stream did not match its final text")
        result = {
          ok: true,
          text: output.text,
          error: "",
          promptTokens: output.inputTokens,
          completionTokens: output.completionTokens,
          finishReason: output.finishReason,
        }
      }
    } catch (error) {
      failure = error
      result = failed(error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(deadline)
      await traceStage("dispose")
      await traceWrites
      let completionFailed = false
      let completionFailure: unknown
      try {
        await worker().complete({ owner: token, id: job.id, result }, { signal: serviceSignal() })
      } catch (error) {
        completionFailed = true
        completionFailure = error
        await reportCompletionDeliveryFailure(token, error)
      }
      if (completionFailed) trace.fail(completionFailure, { active: false, ...heap() })
      else if (result.ok) {
        const inputTokens = activeInputTokens ?? result.promptTokens
        trace.finish({
          ...(typeof inputTokens === "number" ? { actualInputTokens: inputTokens } : {}),
          ...(typeof result.completionTokens === "number"
            ? { outputGeneratedTokens: result.completionTokens }
            : {}),
          active: false,
          ...heap(),
        })
      } else trace.fail(failure ?? result.error, { active: false, ...heap() })
      await traceWrites
      active = undefined
      lastUsed = wallNow()
      if (completionFailed) void unload()
      else if (!unloading && !disposed && !recovery && state() !== "error") ready()
    }
  }

  const unload = (): Promise<void> => {
    autoload = false
    recoveryRetry = undefined
    if (unloading) return unloading
    setState("loading")
    setPhase("loading")
    const operation = Promise.resolve().then(async () => {
      try {
        loadController?.abort(new Error("Model loading cancelled"))
        recoveryController?.abort(new Error("GPU recovery cancelled"))
        active?.controller.abort(new Error("Local inference cancelled"))
        await initializing?.catch(() => {})
        await active?.done.catch(() => {})
        await recovery
        await models.release()
        setResident(models.current())
        const lease = owner
        if (lease && (!ctx.signal.aborted || !supportsLeaseHandoff)) {
          if (await detachWorker(lease))
            await retireLease(lease, crypto.randomUUID(), serviceSignal())
        }
        setGPU("")
        ready()
      } catch (error) {
        // Keep the main-process lease when model disposal fails: another window must not allocate.
        setResident(models.current())
        fail(error)
      } finally {
        unloading = undefined
      }
    })
    unloading = operation
    return operation
  }

  const load = async (warm = false) => {
    if (disposed || unloading || models.current() || !usesGPU(features())) return
    if (initializing) {
      await initializing
      if (
        warm &&
        !disposed &&
        !unloading &&
        owner &&
        !active &&
        !models.current() &&
        contractStatus() === "compatible" &&
        usesGPU(features()) &&
        !(await worker().demand({}, { signal: ctx.signal })).requested &&
        !active
      ) {
        await ensureModel(
          modelKindForInference(needsChat(features()) ? "text" : "systemone"),
          ctx.signal,
        )
        ready()
      }
      return
    }
    if (wallNow() < nextLoadAttempt) return
    nextLoadAttempt = wallNow() + Math.min(30_000, 1_000 * 2 ** Math.min(loadFailures++, 5))
    loadController = new AbortController()
    const controller = loadController
    const signal = AbortSignal.any([ctx.signal, controller.signal, AbortSignal.timeout(600_000)])
    setState("loading")
    setPhase("loading")
    setDetail("Preparing verified local model files")
    initializing = (async () => {
      try {
        await verifyCompletionContract(signal)
        if (!navigator.gpu) throw new Error("WebGPU is unavailable in this Desktop renderer")
        const lease = await acquireLease(signal)
        attachPending = true
        await worker().attach(
          { owner: lease.owner, contractRevision: GENERATION_RESULT_CONTRACT_REVISION },
          { signal },
        )
        attachPending = false
        // Let the mailbox select the model if an inference request is already waiting.
        // Warming chat first would allocate it only to immediately switch to decisions.
        if (warm && !(await worker().demand({}, { signal })).requested)
          await ensureModel(
            modelKindForInference(needsChat(features()) ? "text" : "systemone"),
            signal,
          )
        nextLoadAttempt = 0
        loadFailures = 0
        autoload = false
        ready()
      } catch (error) {
        autoload =
          !controller.signal.aborted &&
          !disposed &&
          usesGPU(features()) &&
          contractStatus() !== "incompatible"
        controller.abort()
        try {
          await models.release()
          setResident(models.current())
        } catch (cleanup) {
          autoload = false
          setResident(models.current())
          fail(`Model cleanup failed; GPU ownership retained: ${String(cleanup)}`)
          return
        }
        if (owner && (!ctx.signal.aborted || !supportsLeaseHandoff)) {
          const lease = owner
          try {
            if (await detachWorker(lease, error))
              await retireLease(lease, crypto.randomUUID(), serviceSignal())
          } catch (cleanup) {
            if (!(cleanup instanceof WorkerDetachError)) autoload = false
            fail(
              `Model load failed: ${errorDetail(error)}. Cleanup failed: ${errorDetail(cleanup)}`,
            )
            return
          }
        }
        fail(error)
      }
    })()
    try {
      await initializing
    } finally {
      initializing = undefined
      loadController = undefined
    }
  }

  const releaseResident = async () => {
    try {
      await models.release()
      setResident(undefined)
      setGPU("")
      ready()
    } catch (error) {
      fail(error)
    }
  }

  const idleExpired = () =>
    !active &&
    !initializing &&
    !switching &&
    !recovery &&
    !models.isTainted() &&
    models.current() !== undefined &&
    (keepAliveMs() ?? -1) >= 0 &&
    wallNow() - lastUsed >= keepAliveMs()!

  /** "Never" unload: the configured model stays resident whenever local inference is on. */
  let manualUnload = false
  const keepResident = () => !manualUnload && (keepAliveMs() ?? 0) < 0 && usesGPU(features())

  /** Restores residency after a generation reload, ownership loss, failure or device loss. */
  let restoreRetryAt: number | undefined
  const restoreResident = async () => {
    if (state() === "error") {
      // A failure never retargets instantly; wait out the same bounded backoff first.
      restoreRetryAt ??= wallNow() + Math.min(30_000, 1_000 * 2 ** Math.min(loadFailures, 5))
      if (wallNow() < restoreRetryAt) return
    }
    restoreRetryAt = undefined
    if (wallNow() < nextLoadAttempt) return
    if (!owner) return load(true)
    nextLoadAttempt = wallNow() + Math.min(30_000, 1_000 * 2 ** Math.min(loadFailures++, 5))
    try {
      await ensureModel(
        modelKindForInference(needsChat(features()) ? "text" : "systemone"),
        ctx.signal,
      )
      nextLoadAttempt = 0
      loadFailures = 0
      ready()
    } catch {
      /* ensureModel recorded the failure; the backoff above gates the next attempt. */
    }
  }

  let checking = false
  const tick = async () => {
    if (checking || disposed || unloading) return
    checking = true
    try {
      if (!usesGPU(features())) {
        if (models.isTainted()) {
          ready()
          return
        }
        if (owner || initializing || models.current()) await unload()
        ready()
        return
      }
      if (autoload && (!owner || attachPending) && !initializing) {
        void load()
        return
      }
      if (owner && contractStatus() === "compatible" && !polling) {
        polling = true
        try {
          const lease = owner
          const token = lease.owner
          const response = await worker().poll(
            { owner: token, available: !active && !initializing && !switching && !recovery },
            { signal: serviceSignal() },
          )
          if (pollDisconnected) {
            pollDisconnected = false
            if (!active && !initializing && !switching && !recovery) ready()
          }
          if (response.cancelID && active?.id === response.cancelID)
            active.controller.abort(new Error("Local inference cancelled"))
          else if (response.cancelID && !active) {
            try {
              await worker().complete(
                {
                  owner: token,
                  id: response.cancelID,
                  result: failed("Cancelled before execution"),
                },
                { signal: serviceSignal() },
              )
            } catch (error) {
              await reportCompletionDeliveryFailure(token, error)
              await unload()
            }
          }
          if (response.job && !active && !unloading) {
            const controller = new AbortController()
            active = {
              id: response.job.id,
              feature: response.job.feature,
              controller,
              done: run(response.job, token, controller),
            }
          }
        } catch (error) {
          if (!isRendererOwnershipLost(error)) {
            // Transport latency does not establish loss of the broker or GPU lease.
            pollDisconnected = true
            if (idleExpired()) await releaseResident()
            fail(
              `Local model connection interrupted: ${errorDetail(error)}. Retrying automatically.`,
            )
            return
          }
          pollDisconnected = false
          await unload()
          // A failed broker detach retains our lease after GPU disposal. Reattach
          // that same owner through the existing load backoff once transport recovers.
          if (
            (!owner || attachPending) &&
            !models.isTainted() &&
            !disposed &&
            usesGPU(features()) &&
            contractStatus() !== "incompatible"
          ) {
            autoload = true
            loadFailures = 1
            nextLoadAttempt = wallNow() + 1_000
            fail(`Local model disconnected: ${errorDetail(error)}. Reconnecting automatically.`)
          }
        } finally {
          polling = false
        }
      }
      if (
        owner &&
        recoveryRetry &&
        wallNow() >= recoveryRetry.at &&
        !active &&
        !initializing &&
        !switching &&
        !recovery &&
        !models.isTainted()
      ) {
        const kind = recoveryRetry.kind
        recoveryRetry = undefined
        recover(kind)
      }
      if (
        owner &&
        !active &&
        !initializing &&
        !switching &&
        !recovery &&
        !recoveryRetry &&
        state() !== "error" &&
        !models.isTainted() &&
        ((models.current() === "audio" && !needsChat(features())) ||
          (models.current() === "decision" && !featureEnabled(features(), "decisions")))
      ) {
        await releaseResident()
      }
      if (state() === "loading") {
        const [a, b] = await Promise.all([
          files.status({ signal: serviceSignal() }),
          files.decisionStatus({ signal: serviceSignal() }),
        ])
        if (a.phase === "downloading" || b.phase === "downloading") {
          setPhase("downloading")
          setDetail(
            `Downloading local models · ${Math.floor(((a.downloadedBytes + b.downloadedBytes) / (MODEL_BYTES + DECISION_BYTES)) * 100)}%`,
          )
        } else setPhase("loading")
      } else if (
        !owner &&
        !initializing &&
        (await worker().demand({}, { signal: serviceSignal() })).requested
      )
        void load()
      else if (idleExpired()) await releaseResident()
      else if (
        keepResident() &&
        !active &&
        !initializing &&
        !switching &&
        !recovery &&
        !recoveryRetry &&
        !unloading &&
        !models.current() &&
        !models.isTainted() &&
        contractStatus() !== "incompatible"
      )
        await restoreResident()
    } catch {
      /* The next tick retries a disconnected service; bounded model loading has its own policy. */
    } finally {
      checking = false
    }
  }
  const started = now()
  let lastTick = started
  const stopTimer = (
    timing.schedule ??
    ((callback, delayMs) => {
      const timer = setInterval(callback, delayMs)
      return () => clearInterval(timer)
    })
  )(() => {
    const current = now()
    const lag = Math.max(0, current - lastTick - 500)
    lastTick = current
    if (lag >= 1_000) runtimeTrace.rendererLag(Math.min(86_400_000, Math.round(lag)), heap())
    void tick()
  }, 500)
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    disposed = true
    stopTimer()
    updateGeneration(generationID, (entry) => {
      entry.state = "disposing"
    })
    disposal = unload().then(() => {
      if (models.current() === undefined && !models.isTainted()) {
        updateGeneration(generationID, (entry) => {
          entry.state = "disposed"
          entry.disposalID = crypto.randomUUID()
        })
      } else {
        updateGeneration(generationID, (entry) => {
          entry.state = "failed"
          delete entry.disposalID
        })
      }
    })
    return disposal
  }
  ctx.signal.addEventListener(
    "abort",
    () => {
      void dispose()
    },
    { once: true },
  )
  let wasEnabled = false
  let previous: Features | undefined
  createEffect(() => {
    const settings = features()
    const enabled = usesGPU(settings)
    if (active && !featureEnabled(settings, active.feature))
      active.controller.abort(new Error("Feature turned off"))
    if (
      previous &&
      ((needsChat(previous) && !needsChat(settings)) ||
        (featureEnabled(previous, "decisions") && !featureEnabled(settings, "decisions")))
    ) {
      if (initializing) {
        loadController?.abort(new Error("Model features turned off"))
        autoload = enabled
      }
      if (
        (recoveryKind === "audio" && !needsChat(settings)) ||
        (recoveryKind === "decision" && !featureEnabled(settings, "decisions"))
      )
        recoveryController?.abort(new Error("Model features turned off"))
    }
    if (!enabled) {
      autoload = false
      loadController?.abort(new Error("Local inference turned off"))
      recoveryController?.abort(new Error("Local inference turned off"))
      cancelLease()
      void unload()
    } else if (!wasEnabled) {
      autoload = true
      if (!unloading) {
        void load()
      }
    }
    wasEnabled = enabled
    previous = settings
  })
  const modelIdentity = () => {
    const kind = resident()
    if (kind === "decision")
      return {
        backend: "d1" as const,
        repository: DECISION_REPOSITORY,
        revision: DECISION_REVISION,
        precision: "Q8",
        artifacts: artifactIdentity(DECISION_FILES),
        runtimeRevision: RUNNTIME_REVISION,
      }
    if (kind === "audio")
      return {
        backend: "runntime" as const,
        repository: MODEL_REPOSITORY,
        revision: MODEL_REVISION,
        precision: "language Q4_K_M + projector Q8_0",
        artifacts: artifactIdentity(MODEL_FILES, [tokenizerIdentity]),
        runtimeRevision: RUNNTIME_REVISION,
      }
    return undefined
  }
  return {
    enabled: (feature: LocalFeature) => featureEnabled(features(), feature),
    state,
    detail,
    gpu,
    phase,
    resident,
    modelIdentity,
    contractStatus,
    modelName: () => {
      const kind = resident()
      if (kind === "decision") return "d1"
      if (kind === "audio") return "ruNNtime Omni"
      return undefined
    },
    audioRoute,
    load: () => {
      if (!unloading) manualUnload = false
      return load(true)
    },
    /** A user-requested unload holds the model out until the next load or job. */
    unload: () => {
      manualUnload = true
      return unload()
    },
    dispose,
    cancel: () => {
      loadController?.abort(new Error("Model loading cancelled"))
      recoveryController?.abort(new Error("GPU recovery cancelled"))
      active?.controller.abort(new Error("Local inference cancelled"))
      cancelLease()
    },
    canSimulateDeviceLoss: () => {
      const current = resident()
      return Boolean(
        current && state() === "ready" && (models.get("decision") || models.get("audio")),
      )
    },
    simulateDeviceLoss: () => {
      const audio = models.get("audio")
      if (audio) audio.loseDevice()
      else models.get("decision")?.engine.loseDevice()
    },
    generate: (prompt: string, signal?: AbortSignal) =>
      rpc().ask({ prompt, maxTokens: 128, timeoutMs: OMNI_REQUEST_TIMEOUT_MS }, { signal }),
    decide: (input: DecisionInput, signal?: AbortSignal) => rpc().decide(input, { signal }),
    systemOne: (input: SystemOneInput, signal?: AbortSignal) => rpc().systemOne(input, { signal }),
    speak: (prompt: string, signal?: AbortSignal, route?: ChatRoute) =>
      rpc().speak(
        {
          prompt,
          voice: voice(),
          route: route ?? audioRoute(),
          maxTokens: 512,
          timeoutMs: OMNI_REQUEST_TIMEOUT_MS,
        },
        { signal },
      ),
    transcribe: async (
      audioBase64: string,
      onText: (text: string) => void,
      signal?: AbortSignal,
      route?: ChatRoute,
    ) => {
      const requestID = crypto.randomUUID()
      transcripts.set(requestID, onText)
      try {
        return await rpc().transcribe(
          {
            audioBase64,
            requestID,
            route: route ?? audioRoute(),
            timeoutMs: OMNI_REQUEST_TIMEOUT_MS,
          },
          { signal },
        )
      } finally {
        transcripts.delete(requestID)
      }
    },
  }
}
export type InferenceRuntime = ReturnType<typeof createInferenceRuntime>
