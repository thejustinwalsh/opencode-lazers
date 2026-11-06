import type {
  ModelLeaseAcquire,
  ModelLeaseGrant,
  ModelLeaseIdentity,
  ModelLeaseRetirement,
} from "./ipc.ts"

type ReleaseRequest = {
  lease: ModelLeaseIdentity
  retirementID: string
  rendererDisposalID: string
}

type RegisteredGeneration = { generationID: string; generationSequence: number }
type LeaseOwner = { window: number; lease: ModelLeaseIdentity }
type AcquireOperation = {
  window: number
  fingerprint: string
  generationID: string
  generationSequence: number
  providerEpoch: string
  pending?: Promise<ModelLeaseGrant>
  grant?: ModelLeaseGrant
}
type RetirementOperation = {
  window: number
  fingerprint: string
  pending?: Promise<ModelLeaseRetirement>
  result?: ModelLeaseRetirement
}

const MAX_REMEMBERED_OPERATIONS = 64

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
  private retiring: Promise<unknown> | undefined
  private clearing = false
  private readonly generations = new Map<number, RegisteredGeneration>()
  private readonly legacySequences = new Map<number, number>()
  private readonly acquisitions = new Map<string, AcquireOperation>()
  private readonly retirements = new Map<string, RetirementOperation>()

  constructor(private readonly drain: () => Promise<void>) {}

  occupied() {
    return Boolean(this.owner || this.retiring || this.clearing)
  }

  registerGeneration(window: number, generationID: string, generationSequence: number) {
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
      if (this.owner) throw new Error("The model cache is owned or being cleaned up")
      const identity = {
        owner: crypto.randomUUID(),
        generationID: request.generationID,
        generationSequence: request.generationSequence,
        operationID: request.operationID,
        providerEpoch: request.providerEpoch,
      }
      const grant: ModelLeaseGrant = identity
      remember(this.acquisitions, request.operationID, {
        window,
        fingerprint,
        generationID: request.generationID,
        generationSequence: request.generationSequence,
        providerEpoch: request.providerEpoch,
        grant,
      })
      this.owner = { window, lease: identity }
      return Promise.resolve(grant)
    }

    const predecessor = request.predecessor
    if (predecessor.providerEpoch !== this.providerEpoch)
      throw new Error("The predecessor belongs to a different main-process provider")
    if (!predecessor.rendererDisposalID || !predecessor.retirementID)
      throw new Error("Renderer disposal is not proven")
    if (this.retiring) throw new Error("The model cache is being cleaned up")
    if (!this.owner || this.owner.window !== window || !sameLease(this.owner.lease, predecessor))
      throw new Error("The predecessor no longer owns the model cache")

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
      window,
      fingerprint,
      generationID: request.generationID,
      generationSequence: request.generationSequence,
      providerEpoch: request.providerEpoch,
    }
    const retirement: RetirementOperation = {
      window,
      fingerprint: retirementFingerprint,
    }
    const pending = Promise.resolve()
      .then(() => this.drain())
      .then(() => {
        this.assertCurrentGeneration(window, request.generationID, request.generationSequence)
        if (
          !this.owner ||
          this.owner.window !== window ||
          !sameLease(this.owner.lease, predecessor)
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
        operation.grant = grant
        retirement.result = retired
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
    if (
      !operation ||
      operation.window !== window ||
      operation.generationID !== identity.generationID ||
      operation.providerEpoch !== identity.providerEpoch
    )
      return undefined
    if (operation.pending) return operation.pending
    return operation.grant
  }

  assert(window: number, lease: ModelLeaseIdentity | string) {
    const matches =
      typeof lease === "string"
        ? this.owner?.lease.owner === lease
        : this.owner && sameLease(this.owner.lease, lease)
    if (this.retiring || this.owner?.window !== window || !matches)
      throw new Error("This window does not own the WebGPU model")
  }

  release(window: number, request: ReleaseRequest): Promise<ModelLeaseRetirement>
  release(window: number, owner: string): Promise<void>
  release(window: number, request: ReleaseRequest | string): Promise<ModelLeaseRetirement | void> {
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

    const operation: RetirementOperation = { window, fingerprint }
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
    const current = this.generations.get(window)
    if (
      !current ||
      current.generationID !== generationID ||
      current.generationSequence !== generationSequence
    )
      throw new Error("A stale renderer generation cannot acquire the model cache")
  }

  async clear(run: () => Promise<void>) {
    if (this.occupied()) throw new Error("Unload the model before removing cached files")
    this.clearing = true
    try {
      await run()
    } finally {
      this.clearing = false
    }
  }
}
