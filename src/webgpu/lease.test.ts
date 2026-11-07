import { expect, test } from "bun:test"
import { ModelLease } from "./lease.ts"
import type { ModelLeasePersistence } from "./lease.ts"
import type { ModelLeaseAcquire, ModelLeaseGrant } from "./ipc.ts"

const request = (
  lease: ModelLease,
  generationID: string,
  generationSequence: number,
  operationID = `acquire-${generationID}`,
  predecessor?: ModelLeaseAcquire["predecessor"],
): ModelLeaseAcquire => ({
  generationID,
  generationSequence,
  operationID,
  providerEpoch: lease.providerEpoch,
  ...(predecessor ? { predecessor } : {}),
})

const register = (lease: ModelLease, window: number, generationID: string, sequence: number) =>
  lease.registerGeneration(window, generationID, sequence)

const handoff = (
  lease: ModelLease,
  from: ModelLeaseGrant,
  generationID: string,
  generationSequence: number,
  operationID = `acquire-${generationID}`,
) =>
  request(lease, generationID, generationSequence, operationID, {
    ...from,
    retirementID: `retire-${from.operationID}-to-${generationID}`,
    rendererDisposalID: `dispose-${from.generationID}`,
  })

test("cache cleanup and retirement exclude new allocations until asynchronous work drains", async () => {
  const draining = Promise.withResolvers<void>()
  const lease = new ModelLease(() => draining.promise)
  const token = lease.acquire(1)
  expect(() => lease.assert(2, token)).toThrow()
  await lease.lost(2)
  lease.assert(1, token)
  const release = lease.release(1, token)
  expect(() => lease.assert(1, token)).toThrow()
  expect(() => lease.acquire(2)).toThrow()
  await expect(lease.clear(async () => {})).rejects.toThrow()
  draining.resolve()
  await release
  const clearing = Promise.withResolvers<void>()
  const cleanup = lease.clear(() => clearing.promise)
  expect(lease.occupied()).toBe(true)
  expect(() => lease.acquire(2)).toThrow()
  clearing.resolve()
  await cleanup
  expect(lease.acquire(2)).not.toBe(token)
})

test("a failed retirement retains ownership; a failed cleanup releases the maintenance barrier", async () => {
  let fail = true
  const lease = new ModelLease(async () => {
    if (fail) throw new Error("drain failed")
  })
  const token = lease.acquire(1)
  await expect(lease.lost(1)).rejects.toThrow("drain failed")
  expect(() => lease.acquire(2)).toThrow()
  lease.assert(1, token)
  fail = false
  await lease.release(1, token)
  await expect(
    lease.clear(async () => {
      throw new Error("disk failed")
    }),
  ).rejects.toThrow("disk failed")
  expect(lease.occupied()).toBe(false)
  expect(lease.acquire(2)).toBeString()
})

test("registered handoff waits for proven renderer disposal, drains atomically, and excludes clear/other windows", async () => {
  const draining = Promise.withResolvers<void>()
  const lease = new ModelLease(() => draining.promise)
  register(lease, 1, "generation-a", 1)
  const a = await lease.acquire(1, request(lease, "generation-a", 1))
  register(lease, 1, "generation-b", 2)
  const pending = lease.acquire(1, handoff(lease, a, "generation-b", 2))

  await Promise.resolve()
  expect(lease.occupied()).toBe(true)
  expect(() => lease.assert(1, a)).toThrow()
  await expect(lease.clear(async () => {})).rejects.toThrow("Unload the model")
  register(lease, 2, "other-window", 1)
  expect(() => lease.acquire(2, request(lease, "other-window", 1))).toThrow("cleaned up")
  draining.resolve()

  const b = await pending
  expect(b.owner).toBe(a.owner)
  expect(b.retired).toMatchObject({
    retirementID: "retire-acquire-generation-a-to-generation-b",
    generationID: "generation-a",
    operationID: "acquire-generation-a",
    providerEpoch: lease.providerEpoch,
    rendererDisposalID: "dispose-generation-a",
    windowID: 1,
  })
  expect(() => lease.assert(1, a)).toThrow()
  expect(() => lease.assert(2, b)).toThrow()
  expect(() => lease.acquire(2, request(lease, "other-window", 1))).toThrow("owned")
  await expect(lease.clear(async () => {})).rejects.toThrow("Unload the model")
  lease.assert(1, b)
})

test("failed or stale handoffs keep the predecessor occupied and never accept a foreign epoch/window", async () => {
  let failDrain = true
  const lease = new ModelLease(async () => {
    if (failDrain) throw new Error("cache drain failed")
  })
  register(lease, 1, "generation-a", 1)
  const a = await lease.acquire(1, request(lease, "generation-a", 1))
  register(lease, 1, "generation-b", 2)
  const bRequest = handoff(lease, a, "generation-b", 2)
  await expect(lease.acquire(1, bRequest)).rejects.toThrow("cache drain failed")
  expect(lease.occupied()).toBe(true)
  lease.assert(1, a)
  register(lease, 2, "foreign", 1)
  expect(() => lease.acquire(2, request(lease, "foreign", 1))).toThrow("owned")

  const foreign = {
    ...handoff(lease, a, "generation-b", 2, "foreign-operation"),
    providerEpoch: "different-provider-epoch",
  }
  expect(() => lease.acquire(1, foreign)).toThrow("provider epoch changed")
  const wrongWindow = handoff(lease, a, "generation-b", 2, "wrong-window-operation")
  expect(() => lease.acquire(2, wrongWindow)).toThrow("stale renderer generation")

  failDrain = false
  const b = await lease.acquire(1, bRequest)
  register(lease, 1, "generation-c", 3)
  const cRequest = handoff(lease, b, "generation-c", 3)
  const c = await lease.acquire(1, cRequest)
  expect(c.retired?.generationID).toBe("generation-b")
  expect(() =>
    lease.release(1, {
      lease: b,
      retirementID: "stale-b-release",
      rendererDisposalID: "dispose-generation-b",
    }),
  ).toThrow("does not own")
  register(lease, 1, "generation-d", 4)
  expect(() =>
    lease.acquire(1, {
      ...handoff(lease, b, "generation-d", 4),
      predecessor: {
        ...b,
        providerEpoch: "different-provider-epoch",
        retirementID: "stale-epoch-retirement",
        rendererDisposalID: "dispose-generation-b",
      },
    }),
  ).toThrow("different main-process provider")
  expect(lease.occupied()).toBe(true)
  lease.assert(1, c)
  expect(() => lease.assert(1, b)).toThrow()
})

test("lost acquire and retirement replies reconcile exact operation identities without releasing newer ownership", async () => {
  const lease = new ModelLease(async () => {})
  register(lease, 1, "generation-a", 1)
  const acquireA = request(lease, "generation-a", 1)
  const a = await lease.acquire(1, acquireA)
  register(lease, 1, "generation-b", 2)
  const acquireB = handoff(lease, a, "generation-b", 2)
  const firstBReply = await lease.acquire(1, acquireB)
  // Simulate a response lost after main committed. Retrying the exact operation returns its grant.
  const reconciledB = await lease.reconcileAcquire(1, {
    generationID: "generation-b",
    operationID: acquireB.operationID,
    providerEpoch: lease.providerEpoch,
  })
  expect(reconciledB).toEqual(firstBReply)
  expect(await lease.acquire(1, acquireB)).toEqual(firstBReply)

  register(lease, 1, "generation-c", 3)
  const c = await lease.acquire(1, handoff(lease, firstBReply, "generation-c", 3))
  expect(c.retired?.generationID).toBe("generation-b")
  // The late old acknowledgement is descriptive only; it cannot roll ownership back.
  expect(await lease.acquire(1, acquireB)).toEqual(firstBReply)
  expect(
    await lease.reconcileAcquire(1, {
      generationID: "generation-b",
      operationID: acquireB.operationID,
      providerEpoch: lease.providerEpoch,
    }),
  ).toEqual(firstBReply)
  lease.assert(1, c)
  expect(() => lease.assert(1, firstBReply)).toThrow()
})

test("retirement acknowledgement replay is exact and cannot retire a later owner", async () => {
  const lease = new ModelLease(async () => {})
  register(lease, 1, "generation-a", 1)
  const a = await lease.acquire(1, request(lease, "generation-a", 1))
  const release = {
    lease: {
      owner: a.owner,
      generationID: a.generationID,
      generationSequence: a.generationSequence,
      operationID: a.operationID,
      providerEpoch: a.providerEpoch,
    },
    retirementID: "retire-a",
    rendererDisposalID: "dispose-a",
  }
  const ack = await lease.release(1, release)
  register(lease, 1, "generation-b", 2)
  const b = await lease.acquire(1, request(lease, "generation-b", 2))
  expect(await lease.release(1, release)).toEqual(ack)
  lease.assert(1, b)
  expect(() => lease.release(2, release)).toThrow("identity")
  expect(lease.occupied()).toBe(true)
})

test("a late old cleanup acknowledgement cannot free ownership after a successor registers", async () => {
  const draining = Promise.withResolvers<void>()
  const lease = new ModelLease(() => draining.promise)
  register(lease, 1, "generation-a", 1)
  const a = await lease.acquire(1, request(lease, "generation-a", 1))
  const release = {
    lease: {
      owner: a.owner,
      generationID: a.generationID,
      generationSequence: a.generationSequence,
      operationID: a.operationID,
      providerEpoch: a.providerEpoch,
    },
    retirementID: "late-retirement-a",
    rendererDisposalID: "dispose-a",
  }
  const pendingRelease = lease.release(1, release)
  await Promise.resolve()
  register(lease, 1, "generation-b", 2)
  draining.resolve()
  await expect(pendingRelease).rejects.toThrow("stale renderer generation")
  expect(await lease.reconcileRelease(1, release)).toBeUndefined()
  expect(lease.occupied()).toBe(true)
  lease.assert(1, a)

  const b = await lease.acquire(1, handoff(lease, a, "generation-b", 2))
  expect(b.retired?.retirementID).toBe("retire-acquire-generation-a-to-generation-b")
  lease.assert(1, b)
})

test("a replacement main adopts only the exact predecessor persisted after provider shutdown", async () => {
  let persisted: ModelLeasePersistence | undefined
  const original = new ModelLease(
    async () => {},
    undefined,
    (state) => (persisted = state),
  )
  register(original, 1, "generation-a", 1)
  const aRequest = request(original, "generation-a", 1)
  const a = await original.acquire(1, aRequest)
  expect(persisted?.state).toBe("active")

  original.providerStopped()
  expect(persisted?.state).toBe("retired")
  const replacement = new ModelLease(
    async () => {},
    persisted,
    (state) => (persisted = state),
  )
  expect(replacement.previousProviderEpoch).toBe(original.providerEpoch)
  expect(replacement.previousProviderState).toBe("retired")
  register(replacement, 1, "generation-b", 2)
  const bRequest: ModelLeaseAcquire = {
    ...request(replacement, "generation-b", 2),
    predecessor: {
      owner: a.owner,
      generationID: a.generationID,
      generationSequence: a.generationSequence,
      operationID: a.operationID,
      providerEpoch: a.providerEpoch,
      retirementID: "retire-a-to-b",
      rendererDisposalID: "dispose-a",
    },
  }
  const b = await replacement.acquire(1, bRequest)
  expect(b.owner).toBe(a.owner)
  expect(b.providerEpoch).toBe(replacement.providerEpoch)
  expect(b.retired).toMatchObject({
    generationID: a.generationID,
    operationID: a.operationID,
    providerEpoch: original.providerEpoch,
    rendererDisposalID: "dispose-a",
    windowID: 1,
  })
  expect(persisted?.state).toBe("active")

  register(replacement, 2, "foreign", 1)
  expect(() => replacement.acquire(2, request(replacement, "foreign", 1))).toThrow("owned")
  await expect(replacement.clear(async () => {})).rejects.toThrow("Unload the model")
})

test("an exact host-observed window loss drains once, permits a reset sequence, and preserves broker ownership", async () => {
  const draining = Promise.withResolvers<void>()
  const lease = new ModelLease(() => draining.promise)
  register(lease, 1, "page-a", 3)
  const originalRequest = request(lease, "page-a", 3)
  const original = await lease.acquire(1, originalRequest)

  expect(() => lease.registerGeneration(1, "forged-reset", 1)).toThrow("stale renderer generation")
  register(lease, 2, "other-window", 1)
  await lease.lost(2)
  expect(() => lease.acquire(2, request(lease, "other-window", 1))).toThrow("owned")

  const loss = lease.lost(1)
  expect(lease.lost(1)).toBe(loss)
  const nextRegistration = lease.registerGeneration(1, "page-b", 1)
  expect(nextRegistration).toBeInstanceOf(Promise)
  await Promise.resolve()
  expect(lease.occupied()).toBe(true)
  expect(() => lease.acquire(2, request(lease, "other-window", 1))).toThrow(/owned|cleaned up/)
  await expect(lease.clear(async () => {})).rejects.toThrow("Unload the model")

  draining.resolve()
  await Promise.all([loss, nextRegistration])
  expect(() =>
    lease.acquire(1, {
      ...request(lease, "page-b", 1),
      providerEpoch: "stale-provider-epoch",
    }),
  ).toThrow("provider epoch changed")
  const successor = await lease.acquire(1, request(lease, "page-b", 1))
  expect(successor.owner).toBe(original.owner)
  expect(successor.retired).toBeUndefined()
  expect(() => lease.assert(1, original)).toThrow()
  expect(() => lease.registerGeneration(1, "late-page-a", 1)).toThrow()

  // Exact late replies remain descriptive; they cannot release or replace the successor.
  expect(await lease.acquire(1, originalRequest)).toEqual(original)
  expect(() =>
    lease.release(1, {
      lease: original,
      retirementID: "late-old-release",
      rendererDisposalID: "late-old-disposal",
    }),
  ).toThrow("does not own")
  expect(lease.occupied()).toBe(true)
  lease.assert(1, successor)
  await lease.release(1, {
    lease: successor,
    retirementID: "release-page-b",
    rendererDisposalID: "dispose-page-b",
  })
})

test("failed host-loss drain keeps ownership occupied until an exact retry settles", async () => {
  let failDrain = true
  const lease = new ModelLease(async () => {
    if (failDrain) throw new Error("host-loss drain failed")
  })
  register(lease, 1, "page-a", 1)
  const original = await lease.acquire(1, request(lease, "page-a", 1))

  await expect(lease.lost(1)).rejects.toThrow("host-loss drain failed")
  expect(lease.occupied()).toBe(true)
  lease.assert(1, original)
  expect(() => lease.registerGeneration(1, "page-b", 1)).toThrow("did not settle")
  register(lease, 2, "other-window", 1)
  expect(() => lease.acquire(2, request(lease, "other-window", 1))).toThrow("owned")
  await expect(lease.clear(async () => {})).rejects.toThrow("Unload the model")

  failDrain = false
  await lease.lost(1)
  await lease.registerGeneration(1, "page-b", 1)
  const successor = await lease.acquire(1, request(lease, "page-b", 1))
  expect(successor.owner).toBe(original.owner)
  lease.assert(1, successor)
})

test("only a demonstrably retired inherited owner can use host-loss recovery", async () => {
  let persisted: ModelLeasePersistence | undefined
  const original = new ModelLease(
    async () => {},
    undefined,
    (state) => (persisted = state),
  )
  register(original, 1, "prior-main-page", 4)
  const prior = await original.acquire(1, request(original, "prior-main-page", 4))
  original.providerStopped()

  const replacement = new ModelLease(async () => {}, persisted)
  expect(replacement.previousProviderState).toBe("retired")
  const loss = replacement.lost(1)
  const registration = replacement.registerGeneration(1, "fresh-window-page", 1)
  await Promise.all([loss, registration])
  expect(replacement.previousProviderState).toBe("host-lost")
  const successor = await replacement.acquire(1, request(replacement, "fresh-window-page", 1))
  expect(successor.owner).toBe(prior.owner)
  expect(successor.providerEpoch).toBe(replacement.providerEpoch)
  expect(successor.retired).toBeUndefined()
  register(replacement, 2, "foreign-window", 1)
  expect(() => replacement.acquire(2, request(replacement, "foreign-window", 1))).toThrow("owned")
})

test("unknown provider shutdown stays occupied and lost retirement replies reconcile after replacement", async () => {
  let persisted: ModelLeasePersistence | undefined
  const original = new ModelLease(
    async () => {},
    undefined,
    (state) => (persisted = state),
  )
  register(original, 1, "generation-a", 1)
  const a = await original.acquire(1, request(original, "generation-a", 1))
  const unproven = new ModelLease(async () => {}, persisted)
  expect(unproven.previousProviderState).toBe("unproven")
  expect(unproven.occupied()).toBe(true)
  await unproven.lost(1)
  expect(unproven.occupied()).toBe(true)
  register(unproven, 1, "unproven-successor", 2)
  expect(() => unproven.acquire(1, request(unproven, "unproven-successor", 2))).toThrow("owned")
  await expect(unproven.clear(async () => {})).rejects.toThrow("Unload the model")

  const inconsistentIdle = new ModelLease(async () => {}, { ...persisted!, state: "idle" })
  expect(inconsistentIdle.previousProviderState).toBe("unproven")
  expect(inconsistentIdle.occupied()).toBe(true)

  const release = {
    lease: {
      owner: a.owner,
      generationID: a.generationID,
      generationSequence: a.generationSequence,
      operationID: a.operationID,
      providerEpoch: a.providerEpoch,
    },
    retirementID: "lost-release-a",
    rendererDisposalID: "dispose-a",
  }
  const ack = await original.release(1, release)
  expect(persisted?.state).toBe("idle")
  const replacement = new ModelLease(async () => {}, persisted)
  expect(replacement.previousProviderState).toBe("idle")
  expect(await replacement.reconcileRelease(1, release)).toEqual(ack)
  register(replacement, 1, "generation-b", 2)
  const b = await replacement.acquire(1, request(replacement, "generation-b", 2))
  expect(b.retired).toBeUndefined()
  expect(replacement.occupied()).toBe(true)
})
