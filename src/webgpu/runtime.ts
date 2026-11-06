import { createEffect, createSignal } from "solid-js"
import type { Plugin } from "@opencode/plugin/gui"
import { Lfm3OmniForConditionalGeneration } from "../../.cache/lfm3-engine.js"
import type { Session } from "../../.cache/lfm3-engine.js"
import { ModelFiles } from "./ipc.ts"
import {
  MODEL_BYTES,
  DECISION_BYTES,
  MODEL_FILES,
  MODEL_REPOSITORY,
  MODEL_REVISION,
  MODEL_SHORT_NAMES,
} from "./manifest.ts"
import { cachedModelFetch } from "./files-fetch.ts"
import { LocalInference, RendererInference } from "./rpc.ts"
import type { InferenceJob } from "./rpc.ts"
import type { DecisionInput } from "./decisions.ts"
import { failed } from "./broker.ts"
import { AUDIO_RATE, decodePCM16, wavBase64 } from "./audio.ts"
import { loadDecisionRuntime } from "./decision-runtime.ts"
import type { DecisionRuntime } from "./decision-runtime.ts"
import type { SystemOneInput } from "./system-one.ts"
import { ExclusiveModels, retryLoad } from "./lifecycle.ts"
import { DEFAULT_VOICE, speechInstruction } from "./speech.ts"
import type { SpeechVoice } from "./speech.ts"
import { featureEnabled, usesGPU, needsChat } from "./features.ts"
import type { Features, LocalFeature } from "./features.ts"

import type { InferenceTraceEvent, InferenceTraceMark, TraceStage } from "./inference-trace.ts"
import { RuntimeTrace } from "./runtime-trace.ts"
import type {
  ModelLeaseAcquire,
  ModelLeaseGrant,
  ModelLeaseIdentity,
  ModelLeaseRetirement,
} from "./ipc.ts"

type ModelKind = "chat" | "decision"

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

export function createInferenceRuntime(
  ctx: Parameters<Plugin.Setup>[0],
  keepAliveMs: () => number = () => -1,
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
  const [resident, setResident] = createSignal<ModelKind | undefined>()
  const [target, setTarget] = createSignal<ModelKind | undefined>()
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
    chat: { engine: Lfm3OmniForConditionalGeneration; dispose(): Promise<void> }
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
  let attachPending = false
  let disposed = false
  let unloading: Promise<void> | undefined
  let switching = false
  let recovery: Promise<void> | undefined
  let recoveryController: AbortController | undefined
  let recoveryKind: ModelKind | undefined
  let lastUsed = Date.now()
  let autoload = false
  let losses: number[] = []
  let recoveryRetry: { kind: ModelKind; at: number } | undefined
  let nextLoadAttempt = 0
  let loadFailures = 0
  const serviceSignal = () =>
    AbortSignal.any([ctx.signal, AbortSignal.timeout(timing.serviceTimeoutMs ?? 5_000)])
  const rpc = () => ctx.client.rpc(LocalInference)
  const worker = () => ctx.client.rpc(RendererInference)
  const ready = () => {
    setResident(models.current())
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
    setState(models.current() ? "ready" : "unloaded")
    setPhase(models.current() ? "ready" : "unloaded")
    setDetail(
      models.current() === "decision"
        ? "d1 ready · chat and speech load on demand"
        : models.current() === "chat"
          ? "Chat and speech ready · d1 loads on demand"
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
    let id = previousGenerationID
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
      if (
        provider.previousProviderEpoch !== handoff.providerEpoch ||
        !provider.previousProviderState ||
        provider.previousProviderState === "unproven"
      )
        throw new Error("The main-process provider changed without exact retirement evidence")
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
      (kind === "chat" && !needsChat(features())) ||
      (kind === "decision" && !featureEnabled(features(), "decisions"))
    )
      throw Error("This model's local features are turned off")
    if (models.get(kind)) {
      setResident(models.current())
      setTarget(undefined)
      return
    }
    setTarget(kind)
    const lease = owner
    if (!lease) {
      const error = new Error("Local model cache ownership was lost")
      fail(error)
      throw error
    }
    switching = true
    setState("loading")
    setPhase("loading")
    setResident(models.current())
    setDetail(`Loading ${kind === "chat" ? "chat and speech" : "d1 decision"} model from cache`)
    try {
      if (!usesGPU(features())) throw Error("Local inference is turned off")
      if (supportsLeaseHandoff) {
        if (kind === "chat") await files.ensure(leaseIdentity(lease), { signal })
        else await files.decisionEnsure(leaseIdentity(lease), { signal })
      } else {
        const legacy = files as unknown as {
          ensure(input: { owner: string }, options: { signal: AbortSignal }): Promise<void>
          decisionEnsure(input: { owner: string }, options: { signal: AbortSignal }): Promise<void>
        }
        if (kind === "chat") await legacy.ensure({ owner: lease.owner }, { signal })
        else await legacy.decisionEnsure({ owner: lease.owner }, { signal })
      }
      if (models.current() && (models.current() !== kind || models.isTainted())) {
        await models.release()
        setResident(models.current())
      }
      if (kind === "chat") {
        const loaded = await models.ensure(
          "chat",
          () =>
            retryLoad(
              async () => {
                await traceStage("session-create")
                const engine = await Lfm3OmniForConditionalGeneration.from_pretrained(
                  MODEL_REPOSITORY,
                  {
                    revision: MODEL_REVISION,
                    file: MODEL_FILES[0].name,
                    mmproj: MODEL_FILES[1].name,
                    maxLength: 4_096,
                    cache: false,
                    prefixSnapshotStore: null,
                    signal,
                    fetch: cachedModelFetch((id, offset, length, readSignal) => {
                      if (!supportsLeaseHandoff)
                        return (
                          files as unknown as {
                            read(
                              input: { owner: string; id: string; offset: number; length: number },
                              options: { signal: AbortSignal },
                            ): Promise<string>
                          }
                        ).read(
                          { owner: lease.owner, id, offset, length },
                          { signal: readSignal ?? signal },
                        )
                      return files.read(
                        { ...leaseIdentity(lease), id, offset, length },
                        { signal: readSignal },
                      )
                    }),
                    onProgress: (progress) =>
                      setDetail(
                        `${progress.message ?? "Loading chat model"}${progress.fraction === undefined ? "" : ` · ${Math.floor(progress.fraction * 100)}%`}`,
                      ),
                  },
                )
                await traceStage("session-ready")
                let intentional = false
                void engine.lost.then(() => {
                  if (!intentional && !disposed && !unloading) recover("chat")
                })
                return {
                  engine,
                  dispose: async () => {
                    intentional = true
                    await engine.dispose()
                  },
                }
              },
              signal,
              setDetail,
            ),
          signal,
        )
        const info = loaded.engine.deviceInfo()
        setGPU(info.description || info.vendor || "WebGPU device")
      } else {
        await models.ensure(
          "decision",
          () =>
            retryLoad(
              async () => {
                const engine = await loadDecisionRuntime(
                  (id, offset, length) => {
                    if (!supportsLeaseHandoff)
                      return (
                        files as unknown as {
                          decisionRead(
                            input: { owner: string; id: string; offset: number; length: number },
                            options: { signal: AbortSignal },
                          ): Promise<string>
                        }
                      ).decisionRead({ owner: lease.owner, id, offset, length }, { signal })
                    return files.decisionRead(
                      { ...leaseIdentity(lease), id, offset, length },
                      { signal },
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
        setGPU("WebGPU · d1-Omni-2B Q4f16")
      }
      signal.throwIfAborted()
      setResident(models.current())
      setTarget(undefined)
      lastUsed = Date.now()
    } catch (error) {
      setResident(models.current())
      if (requestedSignal.aborted) {
        if (!models.current()) setTarget(undefined)
        if (!unloading && !disposed) ready()
      } else fail(error)
      throw error
    } finally {
      switching = false
    }
  }

  const recover = (kind: ModelKind) => {
    if (recovery || disposed || unloading) return
    losses = losses.filter((time) => wallNow() - time < 60_000)
    losses.push(wallNow())
    recoveryController = new AbortController()
    recoveryKind = kind
    setTarget(kind)
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
    const trace = runtimeTrace.begin({
      requestID: job.requestID,
      jobID: job.id,
      mode: job.mode,
      feature: job.feature,
      configuredEP: "webgpu",
      contextCapacityTokens: job.mode === "systemone" ? 8_192 : 4_096,
      configuredMaxTokens: job.maxTokens,
    })
    activeInputTokens = undefined
    trace.mark("polled", { active: true, inputChars: job.prompt.length, ...heap() })
    await traceWrites
    const deadline = setTimeout(
      () =>
        controller.abort(
          Object.assign(new Error("Local inference deadline exceeded"), { name: "TimeoutError" }),
        ),
      job.timeoutMs,
    )
    let session: Session | undefined
    let result = failed("Generation did not complete")
    let failure: unknown
    try {
      if (!featureEnabled(features(), job.feature))
        throw Error("This local inference feature is turned off")
      recoveryRetry = undefined
      await traceStage("loading")
      await ensureModel(job.mode === "systemone" ? "decision" : "chat", controller.signal)
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
      if (job.mode === "systemone") {
        const output = await models
          .get("decision")!
          .engine.systemOne(JSON.parse(job.prompt), controller.signal, traceStage)
        result = {
          ok: true,
          text: JSON.stringify(output),
          error: "",
          promptTokens: output.usage.input_tokens,
          completionTokens: 0,
        }
      } else {
        await traceStage("session-create")
        session = models.get("chat")!.engine.create_session()
        await traceStage("session-ready")
        const messages: Parameters<Session["generate"]>[0] =
          job.mode === "transcribe"
            ? (() => {
                const samples = decodePCM16(job.audioBase64)
                const audio = new AudioBuffer({
                  length: samples.length,
                  numberOfChannels: 1,
                  sampleRate: AUDIO_RATE,
                })
                audio.getChannelData(0).set(samples)
                return [
                  {
                    role: "system",
                    content: "Perform ASR in English.",
                  },
                  { role: "user", content: [{ type: "audio" as const, audio }] },
                ]
              })()
            : job.mode === "speak"
              ? [
                  { role: "system", content: speechInstruction(job.voice) },
                  { role: "user", content: job.prompt },
                ]
              : [{ role: "user", content: job.prompt }]
        await traceStage("generate", heap())
        const generation = session.generate(messages, {
          generation_mode: job.mode === "speak" ? "audio" : "text",
          ...(job.mode === "speak"
            ? { depth_decoder_temperature: 0.4, depth_decoder_repetition_penalty: 1.2 }
            : {}),
          max_new_tokens: job.maxTokens,
          signal: controller.signal,
          enable_thinking: false,
        })
        for await (const event of generation) {
          controller.signal.throwIfAborted()
          if (event.type === "text" && event.text) transcripts.get(job.requestID)?.(event.text)
        }
        const output = await generation.result
        controller.signal.throwIfAborted()
        if (job.mode === "speak" && output.finish_reason === "length")
          throw new Error("Speech segment exceeded the generation budget; use shorter text")
        result = {
          ok: true,
          text:
            typeof output.message.content === "string"
              ? output.message.content
              : output.message.content.map((part) => part.text ?? "").join(""),
          error: "",
          promptTokens: output.usage.prompt_tokens,
          completionTokens: output.usage.completion_tokens,
          ...(job.mode === "speak" && Array.isArray(output.message.content)
            ? {
                audioBase64: wavBase64(
                  output.message.content.find((part: { type: string }) => part.type === "audio_out")
                    ?.audio ?? new Float32Array(),
                ),
              }
            : {}),
        }
      }
    } catch (error) {
      failure = error
      result = failed(error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(deadline)
      try {
        await traceStage("dispose")
        await session?.dispose()
      } catch (error) {
        failure = error
        result = failed(`GPU session cleanup failed: ${String(error)}`)
        recover("chat")
      }
      if (result.ok)
        trace.finish({
          actualInputTokens: activeInputTokens ?? result.promptTokens,
          outputGeneratedTokens: result.completionTokens,
          active: false,
          ...heap(),
        })
      else trace.fail(failure, { active: false, ...heap() })
      await traceWrites
      await worker()
        .complete({ owner: token, id: job.id, result }, { signal: serviceSignal() })
        .catch(() => {})
      active = undefined
      lastUsed = Date.now()
      if (!unloading && !disposed && !recovery && state() !== "error") ready()
    }
  }

  const unload = (): Promise<void> => {
    autoload = false
    recoveryRetry = undefined
    if (unloading) return unloading
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
        setTarget(undefined)
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

  const load = async () => {
    if (disposed || unloading || models.current() || !usesGPU(features())) return
    if (initializing) return initializing
    if (wallNow() < nextLoadAttempt) return
    nextLoadAttempt = wallNow() + Math.min(30_000, 1_000 * 2 ** Math.min(loadFailures++, 5))
    loadController = new AbortController()
    const controller = loadController
    const signal = AbortSignal.any([ctx.signal, controller.signal, AbortSignal.timeout(600_000)])
    setState("loading")
    setPhase("loading")
    setTarget(needsChat(features()) ? "chat" : "decision")
    setDetail("Preparing verified local model files")
    const cacheOperations: Promise<void>[] = []
    initializing = (async () => {
      try {
        if (!navigator.gpu) throw new Error("WebGPU is unavailable in this Desktop renderer")
        const lease = await acquireLease(signal)
        attachPending = true
        await worker().attach({ owner: lease.owner }, { signal })
        attachPending = false
        if (needsChat(features()))
          cacheOperations.push(
            retryLoad(
              () =>
                supportsLeaseHandoff
                  ? files.ensure(leaseIdentity(lease), { signal })
                  : (
                      files as unknown as {
                        ensure(
                          input: { owner: string },
                          options: { signal: AbortSignal },
                        ): Promise<void>
                      }
                    ).ensure({ owner: lease.owner }, { signal }),
              signal,
              setDetail,
            ),
          )
        if (featureEnabled(features(), "decisions"))
          cacheOperations.push(
            retryLoad(
              () =>
                supportsLeaseHandoff
                  ? files.decisionEnsure(leaseIdentity(lease), { signal })
                  : (
                      files as unknown as {
                        decisionEnsure(
                          input: { owner: string },
                          options: { signal: AbortSignal },
                        ): Promise<void>
                      }
                    ).decisionEnsure({ owner: lease.owner }, { signal }),
              signal,
              setDetail,
            ),
          )
        await Promise.all(cacheOperations)
        await ensureModel(needsChat(features()) ? "chat" : "decision", signal)
        nextLoadAttempt = 0
        loadFailures = 0
        autoload = false
        ready()
      } catch (error) {
        autoload = !controller.signal.aborted && !disposed && usesGPU(features())
        controller.abort()
        await Promise.allSettled(cacheOperations)
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
      if (owner && !polling) {
        polling = true
        try {
          const lease = owner
          const token = lease.owner
          const response = await worker().poll(
            { owner: token, available: !active && !initializing && !switching && !recovery },
            { signal: serviceSignal() },
          )
          if (response.cancelID && active?.id === response.cancelID)
            active.controller.abort(new Error("Local inference cancelled"))
          else if (response.cancelID && !active)
            await worker().complete(
              {
                owner: token,
                id: response.cancelID,
                result: failed("Cancelled before execution"),
              },
              { signal: serviceSignal() },
            )
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
          await unload()
          if (!owner && !models.isTainted() && !disposed && usesGPU(features())) {
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
        (!models.current() ||
          (models.current() === "chat" && !needsChat(features())) ||
          (models.current() === "decision" && !featureEnabled(features(), "decisions")))
      ) {
        await ensureModel(needsChat(features()) ? "chat" : "decision", ctx.signal)
        ready()
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
      else if (
        models.current() &&
        state() === "ready" &&
        keepAliveMs() >= 0 &&
        Date.now() - lastUsed >= keepAliveMs() &&
        !(await worker().demand({}, { signal: serviceSignal() })).requested
      )
        await unload()
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
        (recoveryKind === "chat" && !needsChat(settings)) ||
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
  return {
    enabled: (feature: LocalFeature) => featureEnabled(features(), feature),
    state,
    detail,
    gpu,
    phase,
    resident,
    modelName: () => {
      void resident()
      const kind = models.current() ?? target()
      return kind ? MODEL_SHORT_NAMES[kind] : undefined
    },
    load,
    unload,
    dispose,
    cancel: () => {
      loadController?.abort(new Error("Model loading cancelled"))
      recoveryController?.abort(new Error("GPU recovery cancelled"))
      active?.controller.abort(new Error("Local inference cancelled"))
      cancelLease()
    },
    simulateDeviceLoss: () => models.get("decision")?.engine.loseDevice(),
    generate: (prompt: string, signal?: AbortSignal) =>
      rpc().ask({ prompt, maxTokens: 128, timeoutMs: 60_000 }, { signal }),
    decide: (input: DecisionInput, signal?: AbortSignal) => rpc().decide(input, { signal }),
    systemOne: (input: SystemOneInput, signal?: AbortSignal) => rpc().systemOne(input, { signal }),
    speak: (prompt: string, signal?: AbortSignal) =>
      rpc().speak({ prompt, voice: voice(), maxTokens: 512, timeoutMs: 60_000 }, { signal }),
    transcribe: async (
      audioBase64: string,
      onText: (text: string) => void,
      signal?: AbortSignal,
    ) => {
      const requestID = crypto.randomUUID()
      transcripts.set(requestID, onText)
      try {
        return await rpc().transcribe({ audioBase64, requestID, timeoutMs: 60_000 }, { signal })
      } finally {
        transcripts.delete(requestID)
      }
    },
  }
}
export type InferenceRuntime = ReturnType<typeof createInferenceRuntime>
