import type {
  ModelLeaseAcquire,
  ModelLeaseGrant,
  ModelLeaseIdentity,
  ModelLeaseRetirement,
} from "./ipc.ts"
import { ModelLeaseGrantSchema, ModelLeaseRetirementSchema } from "./ipc.ts"
import { Schema } from "effect"

type ReleaseRequest = {
  lease: ModelLeaseIdentity
  retirementID: string
  rendererDisposalID: string
}

type RegisteredGeneration = { generationID: string; generationSequence: number }
type LeaseOwner = { window: number; lease: ModelLeaseGrant }
type AcquireOperation = {
  operationID: string
  window: number
  fingerprint: string
  generationID: string
  generationSequence: number
  providerEpoch: string
  pending?: Promise<ModelLeaseGrant>
  grant?: ModelLeaseGrant
}
type RetirementOperation = {
  retirementID: string
  window: number
  fingerprint: string
  pending?: Promise<ModelLeaseRetirement>
  result?: ModelLeaseRetirement
}

const MAX_REMEMBERED_OPERATIONS = 64

const leaseID = Schema.String.check(Schema.isBetweenLength(1, 100))
const leaseSequence = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
)
const leaseWindow = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
const PersistedAcquire = Schema.Struct({
  operationID: leaseID,
  window: leaseWindow,
  fingerprint: Schema.String,
  generationID: leaseID,
  generationSequence: leaseSequence,
  providerEpoch: leaseID,
  grant: Schema.optionalKey(ModelLeaseGrantSchema),
})
const PersistedRetirement = Schema.Struct({
  retirementID: leaseID,
  window: leaseWindow,
  fingerprint: Schema.String,
  result: Schema.optionalKey(ModelLeaseRetirementSchema),
})

export const ModelLeasePersistenceSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1]),
  providerEpoch: leaseID,
  state: Schema.Literals(["idle", "active", "retired", "unproven"]),
  windowID: Schema.optionalKey(leaseWindow),
  lease: Schema.optionalKey(ModelLeaseGrantSchema),
  acquisitions: Schema.Array(PersistedAcquire).check(
    Schema.isBetweenLength(0, MAX_REMEMBERED_OPERATIONS),
  ),
  retirements: Schema.Array(PersistedRetirement).check(
    Schema.isBetweenLength(0, MAX_REMEMBERED_OPERATIONS),
  ),
})
export type ModelLeasePersistence = typeof ModelLeasePersistenceSchema.Type

type InheritedOwner = { window: number; grant: ModelLeaseGrant }
type ProviderOwnershipState = "idle" | "retired" | "unproven"

const sameLease = (left: ModelLeaseIdentity, right: ModelLeaseIdentity) =>
  left.owner === right.owner &&
  left.generationID === right.generationID &&
  left.generationSequence === right.generationSequence &&
  left.operationID === right.operationID &&
  left.providerEpoch === right.providerEpoch

const remember = <T>(map: Map<string, T>, key: string, value: T) => {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_REMEMBERED_OPERATIONS) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** Main-process ownership stays reserved until cache work drains and exact retirement is acknowledged. */
export class ModelLease {
  readonly providerEpoch = crypto.randomUUID()
  private owner: LeaseOwner | undefined
  private inherited: InheritedOwner | undefined
  private blocked = false
  private retiring: Promise<unknown> | undefined
  private clearing = false
  private sealed = false
  private readonly generations = new Map<number, RegisteredGeneration>()
  private readonly legacySequences = new Map<number, number>()
  private readonly acquisitions = new Map<string, AcquireOperation>()
  private readonly retirements = new Map<string, RetirementOperation>()
  readonly previousProviderEpoch?: string
  readonly previousProviderState?: ProviderOwnershipState

  constructor(
    private readonly drain: () => Promise<void>,
    previous?: ModelLeasePersistence | null,
    private readonly persistState?: (state: ModelLeasePersistence) => void,
  ) {
    this.previousProviderEpoch = previous?.providerEpoch
    if (!previous) return

    const hasOwnerIdentity = previous.windowID !== undefined && previous.lease !== undefined
    const validRetired = previous.state === "retired" && hasOwnerIdentity
    const validIdle =
      previous.state === "idle" && previous.windowID === undefined && previous.lease === undefined
    const ownershipUnknown =
      previous.state === "active" ||
      previous.state === "unproven" ||
      (previous.state === "retired" && !validRetired) ||
      (previous.state === "idle" && !validIdle)
    this.previousProviderState = ownershipUnknown ? "unproven" : previous.state
    if (validRetired) this.inherited = { window: previous.windowID!, grant: previous.lease! }
    else if (ownershipUnknown) {
      this.blocked = true
      if (previous.windowID !== undefined && previous.lease)
        this.inherited = { window: previous.windowID, grant: previous.lease }
    }

    for (const operation of previous.acquisitions ?? []) {
      this.acquisitions.set(operation.operationID, {
        operationID: operation.operationID,
        window: operation.window,
        fingerprint: operation.fingerprint,
        generationID: operation.generationID,
        generationSequence: operation.generationSequence,
        providerEpoch: operation.providerEpoch,
        ...(operation.grant ? { grant: operation.grant } : {}),
      })
    }
    for (const operation of previous.retirements ?? []) {
      this.retirements.set(operation.retirementID, {
        retirementID: operation.retirementID,
        window: operation.window,
        fingerprint: operation.fingerprint,
        ...(operation.result ? { result: operation.result } : {}),
      })
    }
  }

  persist() {
    this.persistState?.(this.snapshot())
  }

  private snapshot(): ModelLeasePersistence {
    const retained = this.owner
      ? { windowID: this.owner.window, lease: this.owner.lease }
      : this.inherited
        ? { windowID: this.inherited.window, lease: this.inherited.grant }
        : undefined
    return {
      schemaVersion: 1,
      providerEpoch: this.providerEpoch,
      state:
        this.blocked || this.clearing
          ? "unproven"
          : this.owner
            ? "active"
            : this.inherited
              ? "retired"
              : "idle",
      ...(retained ?? {}),
      acquisitions: Array.from(this.acquisitions.values(), (operation) => ({
        operationID: operation.operationID,
        window: operation.window,
        fingerprint: operation.fingerprint,
        generationID: operation.generationID,
        generationSequence: operation.generationSequence,
        providerEpoch: operation.providerEpoch,
        ...(operation.grant ? { grant: operation.grant } : {}),
      })),
      retirements: Array.from(this.retirements.values(), (operation) => ({
        retirementID: operation.retirementID,
        window: operation.window,
        fingerprint: operation.fingerprint,
        ...(operation.result ? { result: operation.result } : {}),
      })),
    }
  }

  occupied() {
    return Boolean(this.owner || this.inherited || this.blocked || this.retiring || this.clearing)
  }

  seal() {
    this.sealed = true
  }

  providerStopped() {
    if (this.retiring || this.clearing)
      throw new Error("Model ownership did not settle before provider cleanup")
    this.sealed = true
    if (this.owner) {
      this.inherited = { window: this.owner.window, grant: this.owner.lease }
      this.owner = undefined
    }
    this.persist()
  }

  providerStopFailed() {
    this.sealed = true
    this.blocked = true
    this.persist()
  }

  registerGeneration(window: number, generationID: string, generationSequence: number) {
    if (this.sealed) throw new Error("The main-process provider is shutting down")
    if (!Number.isSafeInteger(generationSequence) || generationSequence < 1)
      throw new Error("Invalid renderer generation")
    const current = this.generations.get(window)
    if (current && generationSequence < current.generationSequence)
      throw new Error("A stale renderer generation cannot claim the model cache")
    if (current && generationSequence === current.generationSequence) {
      if (current.generationID !== generationID)
        throw new Error("Renderer generation identity does not match")
      return
    }
    this.generations.set(window, { generationID, generationSequence })
  }

  acquire(window: number): string
  acquire(window: number, request: ModelLeaseAcquire): Promise<ModelLeaseGrant>
  acquire(window: number, request?: ModelLeaseAcquire): string | Promise<ModelLeaseGrant> {
    if (this.sealed) throw new Error("The main-process provider is shutting down")
    // Kept for the older direct unit fixtures; the registered IPC surface always supplies identity.
    if (!request) {
      if (this.occupied()) throw new Error("The model cache is owned or being cleaned up")
      const generationSequence = (this.legacySequences.get(window) ?? 0) + 1
      this.legacySequences.set(window, generationSequence)
      const generationID = `legacy-${crypto.randomUUID()}`
      this.generations.set(window, { generationID, generationSequence })
      const identity: ModelLeaseIdentity = {
        owner: crypto.randomUUID(),
        generationID,
        generationSequence,
        operationID: crypto.randomUUID(),
        providerEpoch: this.providerEpoch,
      }
      this.owner = { window, lease: identity }
      remember(this.acquisitions, identity.operationID, {
        operationID: identity.operationID,
        window,
        fingerprint: "legacy",
        generationID,
        generationSequence,
        providerEpoch: identity.providerEpoch,
        grant: identity,
      })
      this.persist()
      return identity.owner
    }
    if (request.providerEpoch !== this.providerEpoch)
      throw new Error("The main-process provider epoch changed")
    const fingerprint = JSON.stringify(request)
    const existing = this.acquisitions.get(request.operationID)
    if (existing) {
      if (
        existing.window !== window ||
        existing.fingerprint !== fingerprint ||
        existing.generationID !== request.generationID ||
        existing.generationSequence !== request.generationSequence ||
        existing.providerEpoch !== request.providerEpoch
      )
        throw new Error("Acquisition identity does not match its original operation")
      if (existing.pending) return existing.pending
      if (existing.grant) return Promise.resolve(existing.grant)
    }

    this.assertCurrentGeneration(window, request.generationID, request.generationSequence)
    if (this.clearing) throw new Error("The model cache is being cleared")

    if (!request.predecessor) {
      if (this.retiring) throw new Error("The model cache is being cleaned up")
      if (this.owner || this.inherited || this.blocked)
        throw new Error("The model cache is owned or being cleaned up")
      const identity = {
        owner: crypto.randomUUID(),
        generationID: request.generationID,
        generationSequence: request.generationSequence,
        operationID: request.operationID,
        providerEpoch: request.providerEpoch,
      }
      const grant: ModelLeaseGrant = identity
      remember(this.acquisitions, request.operationID, {
        operationID: request.operationID,
        window,
        fingerprint,
        generationID: request.generationID,
        generationSequence: request.generationSequence,
        providerEpoch: request.providerEpoch,
        grant,
      })
      this.owner = { window, lease: grant }
      this.persist()
      return Promise.resolve(grant)
    }

    const predecessor = request.predecessor
    if (!predecessor.rendererDisposalID || !predecessor.retirementID)
      throw new Error("Renderer disposal is not proven")
    if (this.retiring) throw new Error("The model cache is being cleaned up")
    const fromCurrentProvider = predecessor.providerEpoch === this.providerEpoch
    const inherited = this.inherited
    if (fromCurrentProvider) {
      if (!this.owner || this.owner.window !== window || !sameLease(this.owner.lease, predecessor))
        throw new Error("The predecessor no longer owns the model cache")
    } else {
      if (this.previousProviderState !== "retired" || !inherited)
        throw new Error("The predecessor belongs to a different main-process provider")
      if (inherited.window !== window || !sameLease(inherited.grant, predecessor))
        throw new Error("The predecessor belongs to an unproven main-process provider")
    }
    if (this.blocked) throw new Error("Previous provider ownership remains unproven")

    const retirementFingerprint = JSON.stringify({
      window,
      lease: {
        generationID: predecessor.generationID,
        generationSequence: predecessor.generationSequence,
        operationID: predecessor.operationID,
        providerEpoch: predecessor.providerEpoch,
      },
      retirementID: predecessor.retirementID,
      rendererDisposalID: predecessor.rendererDisposalID,
      successorGenerationID: request.generationID,
      successorGenerationSequence: request.generationSequence,
      successorOperationID: request.operationID,
    })
    const priorRetirement = this.retirements.get(predecessor.retirementID)
    if (priorRetirement && priorRetirement.fingerprint !== retirementFingerprint)
      throw new Error("Retirement identity does not match its original operation")

    const operation: AcquireOperation = {
      operationID: request.operationID,
      window,
      fingerprint,
      generationID: request.generationID,
      generationSequence: request.generationSequence,
      providerEpoch: request.providerEpoch,
    }
    const retirement: RetirementOperation = {
      retirementID: predecessor.retirementID,
      window,
      fingerprint: retirementFingerprint,
    }
    const pending = Promise.resolve()
      .then(() => this.drain())
      .then(() => {
        this.assertCurrentGeneration(window, request.generationID, request.generationSequence)
        const currentOwner = fromCurrentProvider ? this.owner : this.inherited
        const currentLease = this.owner?.lease ?? this.inherited?.grant
        if (
          !currentOwner ||
          currentOwner.window !== window ||
          !currentLease ||
          !sameLease(currentLease, predecessor)
        )
          throw new Error("The predecessor changed during renderer retirement")
        const retired: ModelLeaseRetirement = {
          windowID: window,
          retirementID: predecessor.retirementID,
          generationID: predecessor.generationID,
          generationSequence: predecessor.generationSequence,
          operationID: predecessor.operationID,
          providerEpoch: predecessor.providerEpoch,
          rendererDisposalID: predecessor.rendererDisposalID,
        }
        const grant: ModelLeaseGrant = {
          owner: predecessor.owner,
          generationID: request.generationID,
          generationSequence: request.generationSequence,
          operationID: request.operationID,
          providerEpoch: request.providerEpoch,
          retired,
        }
        this.owner = { window, lease: grant }
        this.inherited = undefined
        operation.grant = grant
        retirement.result = retired
        this.persist()
        return grant
      })
      .finally(() => {
        if (this.retiring === pending) this.retiring = undefined
        operation.pending = undefined
        retirement.pending = undefined
      })
    operation.pending = pending
    remember(this.acquisitions, request.operationID, operation)
    remember(this.retirements, predecessor.retirementID, retirement)
    this.retiring = pending
    return pending
  }

  async reconcileAcquire(
    window: number,
    identity: { generationID: string; operationID: string; providerEpoch: string },
  ) {
    const operation = this.acquisitions.get(identity.operationID)
    if (operation) {
      if (
        operation.window !== window ||
        operation.generationID !== identity.generationID ||
        operation.providerEpoch !== identity.providerEpoch
      )
        return undefined
      if (operation.pending) return operation.pending
      return operation.grant
    }
    const inherited = this.inherited
    if (
      inherited &&
      inherited.window === window &&
      inherited.grant.generationID === identity.generationID &&
      inherited.grant.operationID === identity.operationID &&
      inherited.grant.providerEpoch === identity.providerEpoch
    )
      return inherited.grant
    return undefined
  }

  assert(window: number, lease: ModelLeaseIdentity | string) {
    const matches =
      typeof lease === "string"
        ? this.owner?.lease.owner === lease
        : this.owner && sameLease(this.owner.lease, lease)
    if (this.sealed || this.blocked || this.retiring || this.owner?.window !== window || !matches)
      throw new Error("This window does not own the WebGPU model")
  }

  release(window: number, request: ReleaseRequest): Promise<ModelLeaseRetirement>
  release(window: number, owner: string): Promise<void>
  release(window: number, request: ReleaseRequest | string): Promise<ModelLeaseRetirement | void> {
    if (this.sealed) throw new Error("The main-process provider is shutting down")
    if (typeof request === "string") {
      const current = this.owner
      if (!current || current.window !== window || current.lease.owner !== request)
        throw new Error("This window does not own the WebGPU model")
      return this.release(window, {
        lease: current.lease,
        retirementID: crypto.randomUUID(),
        rendererDisposalID: `legacy-${crypto.randomUUID()}`,
      }).then(() => {})
    }
    const { lease, retirementID, rendererDisposalID } = request
    if (lease.providerEpoch !== this.providerEpoch)
      throw new Error("The main-process provider epoch changed")
    if (!retirementID || !rendererDisposalID) throw new Error("Renderer disposal is not proven")
    const fingerprint = JSON.stringify({
      window,
      lease: {
        owner: lease.owner,
        generationID: lease.generationID,
        generationSequence: lease.generationSequence,
        operationID: lease.operationID,
        providerEpoch: lease.providerEpoch,
      },
      retirementID,
      rendererDisposalID,
    })
    const existing = this.retirements.get(retirementID)
    if (existing) {
      if (existing.window !== window || existing.fingerprint !== fingerprint)
        throw new Error("Retirement identity does not match its original operation")
      if (existing.pending) return existing.pending
      if (existing.result) return Promise.resolve(existing.result)
    }
    if (this.retiring) throw new Error("The model cache is being cleaned up")
    if (!this.owner || this.owner.window !== window || !sameLease(this.owner.lease, lease))
      throw new Error("This window does not own the WebGPU model")
    this.assertCurrentGeneration(window, lease.generationID, lease.generationSequence)

    const operation: RetirementOperation = { retirementID, window, fingerprint }
    const pending = Promise.resolve()
      .then(() => this.drain())
      .then(() => {
        this.assertCurrentGeneration(window, lease.generationID, lease.generationSequence)
        if (!this.owner || this.owner.window !== window || !sameLease(this.owner.lease, lease))
          throw new Error("Ownership changed during renderer retirement")
        const result: ModelLeaseRetirement = {
          windowID: window,
          retirementID,
          generationID: lease.generationID,
          generationSequence: lease.generationSequence,
          operationID: lease.operationID,
          providerEpoch: lease.providerEpoch,
          rendererDisposalID,
        }
        this.owner = undefined
        operation.result = result
        this.persist()
        return result
      })
      .finally(() => {
        if (this.retiring === pending) this.retiring = undefined
        operation.pending = undefined
      })
    operation.pending = pending
    remember(this.retirements, retirementID, operation)
    this.retiring = pending
    return pending
  }

  async reconcileRelease(window: number, request: ReleaseRequest) {
    const { lease, retirementID, rendererDisposalID } = request
    const operation = this.retirements.get(retirementID)
    const fingerprint = JSON.stringify({
      window,
      lease: {
        owner: lease.owner,
        generationID: lease.generationID,
        generationSequence: lease.generationSequence,
        operationID: lease.operationID,
        providerEpoch: lease.providerEpoch,
      },
      retirementID,
      rendererDisposalID,
    })
    if (!operation || operation.window !== window || operation.fingerprint !== fingerprint)
      return undefined
    if (operation.pending) {
      try {
        return await operation.pending
      } catch {
        return undefined
      }
    }
    return operation.result
  }

  lost(window: number) {
    if (this.sealed) return Promise.resolve()
    const observed = this.owner
    if (!observed || observed.window !== window) return Promise.resolve()
    return (this.retiring?.catch(() => {}) ?? Promise.resolve()).then(() => {
      if (
        !this.owner ||
        this.owner.window !== observed.window ||
        !sameLease(this.owner.lease, observed.lease)
      )
        return
      return this.release(window, {
        lease: observed.lease,
        retirementID: crypto.randomUUID(),
        rendererDisposalID: `host-lifecycle-${crypto.randomUUID()}`,
      })
    })
  }

  private assertCurrentGeneration(
    window: number,
    generationID: string,
    generationSequence: number,
  ) {
    if (this.sealed) throw new Error("The main-process provider is shutting down")
    const current = this.generations.get(window)
    if (
      !current ||
      current.generationID !== generationID ||
      current.generationSequence !== generationSequence
    )
      throw new Error("A stale renderer generation cannot acquire the model cache")
  }

  async clear(run: () => Promise<void>) {
    if (this.sealed) throw new Error("The main-process provider is shutting down")
    if (this.occupied()) throw new Error("Unload the model before removing cached files")
    this.clearing = true
    try {
      this.persist()
      await run()
    } finally {
      this.clearing = false
      this.persist()
    }
  }
}
