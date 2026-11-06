import { canonical } from "../../identity.ts"
import type { ProbeRepository } from "../probe/store.ts"
import { ProbeActorSchema } from "../probe/schema.ts"
import type { ProbeActor, ProbeRun, ProbeVerdict } from "../probe/schema.ts"
import { FilesystemFixtureAdapter } from "./fixture.ts"
import type { OwnedResourceAdapter } from "./fixture.ts"
import { ResourceRegistrationInputSchema } from "./schema.ts"
import type { OwnedResource, ResourceOwner, ResourceRegistrationInput } from "./schema.ts"
import { ResourceRepository } from "./store.ts"

export type ProbeOutcome<T> = {
  verdict: ProbeVerdict
  value: T
}

export type OwnedFixture = {
  resourceID: string
  name: string
  path: string
  generation: number
}

export type OwnedProbeResult<T> = {
  status: "executed" | "replayed" | "blocked" | "interrupted" | "cancelled"
  run: ProbeRun
  value?: T
  cleanupState: ProbeRun["cleanupState"]
  reason?: string
}

export type WithOwnedResourcesInput = {
  runID: string
  actor: ProbeActor
  resources: ResourceRegistrationInput[]
  signal?: AbortSignal
}

type CleanupResult = { complete: boolean; pending?: boolean; reason?: string }

/**
 * Executes a probe at most once after durable registration, then independently
 * records behavior and attempts teardown. Reconciliation only retries effects
 * whose current adapter observation authorizes the next action.
 */
export class OwnedProbeLifecycle {
  readonly resources: ResourceRepository

  constructor(
    private readonly repository: ResourceRepository,
    private readonly probes: ProbeRepository,
    private readonly adapter: OwnedResourceAdapter,
  ) {
    this.resources = repository
  }

  async withOwnedResources<T>(
    input: WithOwnedResourcesInput,
    probe: (
      fixtures: OwnedFixture[],
      signal?: AbortSignal,
    ) => Promise<ProbeOutcome<T>> | ProbeOutcome<T>,
  ): Promise<OwnedProbeResult<T>> {
    const actor = ProbeActorSchema.parse(input.actor)
    let run = this.ownedRun(input.runID, actor)
    const owner = this.owner(run)
    const registrations = input.resources.map((item) => {
      const parsed = ResourceRegistrationInputSchema.parse(item)
      return this.adapter.describe(parsed)
    })
    const registration = this.resources.registerBatch(owner, registrations)
    if (registration.status === "conflict")
      throw new Error(`Owned resource registration failed: ${registration.message}`)
    const records = registration.resources
    const coordinatorID = registration.coordinatorID
    const execution = this.resources.execution(run.runID)
    if (!execution) throw new Error("Owned resource execution receipt was not committed")
    if (
      run.lifecycle === "pending" &&
      (execution.phase === "preparing" || execution.phase === "probing")
    )
      return {
        status: "replayed",
        run,
        cleanupState: run.cleanupState,
        reason:
          "Another invocation may still own setup or probe behavior; cleanup was not attempted",
      }
    let preparationClaimed = false
    if (run.lifecycle === "pending" && execution.phase === "registered") {
      preparationClaimed = this.resources.claimPreparation(run.runID)
      if (!preparationClaimed)
        return {
          status: "replayed",
          run: this.probes.run(run.runID) ?? run,
          cleanupState: "pending",
          reason: "Another invocation claimed resource setup; cleanup was not attempted",
        }
    }
    let cleanupAuthorized = run.lifecycle !== "pending" || preparationClaimed
    let status: OwnedProbeResult<T>["status"]
    let value: T | undefined
    let reason: string | undefined
    let cleanup: CleanupResult
    try {
      if (run.lifecycle === "completed" || run.lifecycle === "cancelled") {
        status = "replayed"
      } else if (
        run.lifecycle === "interrupted" ||
        execution.phase === "interrupted" ||
        execution.phase === "finished"
      ) {
        if (run.lifecycle === "pending") {
          run = this.updateRun(run, actor, "interrupted", null, "pending")
          cleanupAuthorized = true
        }
        if (execution.phase === "probing")
          this.resources.setExecutionPhase(run.runID, "interrupted")
        status = "interrupted"
        reason = "A prior probe attempt may have started; callback replay is suppressed"
      } else if (input.signal?.aborted) {
        run = this.updateRun(run, actor, "cancelled", null, "pending")
        this.resources.setExecutionPhase(run.runID, "finished")
        status = "cancelled"
        cleanupAuthorized = true
      } else {
        let setupFailure: { error: unknown } | null = null
        try {
          const reconciled = this.reconcileRecords(records, coordinatorID)
          for (const resource of reconciled) {
            if (resource.state === "removed")
              throw new Error(
                `Resource ${resource.name} was already removed and cannot be replayed`,
              )
            this.adapter.reserve(resource, coordinatorID)
            this.createIfAbsent(resource, coordinatorID)
          }
        } catch (error) {
          setupFailure = { error }
        }

        if (setupFailure !== null) {
          reason = this.errorMessage(setupFailure.error)
          run = this.updateRun(run, actor, "completed", "environment-blocked", "pending")
          this.resources.setExecutionPhase(run.runID, "finished")
          status = "blocked"
          cleanupAuthorized = true
        } else if (input.signal?.aborted) {
          run = this.updateRun(run, actor, "cancelled", null, "pending")
          this.resources.setExecutionPhase(run.runID, "finished")
          status = "cancelled"
          cleanupAuthorized = true
        } else {
          if (!this.resources.beginProbe(run.runID)) {
            status = "replayed"
            cleanupAuthorized = false
            reason = "Probe behavior is no longer exclusively owned; cleanup was not attempted"
          } else {
            cleanupAuthorized = true
            const fixtures = records.map((resource) => this.fixture(resource))
            try {
              const outcome = await probe(fixtures, input.signal)
              if (input.signal?.aborted) {
                run = this.updateRun(run, actor, "cancelled", null, "pending")
                this.resources.setExecutionPhase(run.runID, "finished")
                status = "cancelled"
              } else {
                run = this.updateRun(run, actor, "completed", outcome.verdict, "pending")
                this.resources.setExecutionPhase(run.runID, "finished")
                value = outcome.value
                status = "executed"
              }
            } catch (error) {
              if (input.signal?.aborted) {
                run = this.updateRun(run, actor, "cancelled", null, "pending")
                this.resources.setExecutionPhase(run.runID, "finished")
                status = "cancelled"
              } else {
                // The callback may have produced effects before its reply was lost.
                // Persist interruption and never invoke it again for this run.
                run = this.updateRun(run, actor, "interrupted", null, "pending")
                this.resources.setExecutionPhase(run.runID, "interrupted")
                status = "interrupted"
                reason = this.errorMessage(error)
              }
            }
          }
        }
      }
    } catch (error) {
      status = "interrupted"
      reason = this.errorMessage(error)
      try {
        const latest = this.probes.run(run.runID)
        if (latest?.lifecycle === "pending")
          run = this.updateRun(latest, actor, "interrupted", null, "pending")
      } catch (updateError) {
        reason = `${reason}; could not persist interruption: ${this.errorMessage(updateError)}`
      }
    } finally {
      if (cleanupAuthorized) {
        try {
          cleanup = this.cleanupRecords(run.runID, records, coordinatorID)
        } catch (error) {
          cleanup = { complete: false, reason: this.errorMessage(error) }
        }
      } else {
        cleanup = {
          complete: false,
          pending: true,
          reason: "Teardown remains reserved for the active invocation",
        }
      }
    }

    if (cleanupAuthorized) {
      try {
        run = this.setProbeCleanup(run.runID, actor, cleanup.complete ? "complete" : "failed")
      } catch (error) {
        cleanup = { complete: false, reason: this.errorMessage(error) }
        reason = [reason, `Could not persist cleanup status: ${cleanup.reason}`]
          .filter(Boolean)
          .join("; ")
      }
    }
    if (!cleanup.complete) reason = [reason, cleanup.reason].filter(Boolean).join("; ")
    return {
      status,
      run,
      ...(value === undefined ? {} : { value }),
      cleanupState: cleanup.pending ? "pending" : cleanup.complete ? "complete" : "failed",
      ...(reason ? { reason } : {}),
    }
  }

  /**
   * Reconcile after the caller has confirmed the prior worker stopped. An
   * unfinished run is never released merely because a timeout or restart occurred.
   */
  reconcile(
    runID: string,
    actorInput: unknown,
    confirmation?: { workerStopped?: boolean },
  ): OwnedProbeResult<never> {
    const actor = ProbeActorSchema.parse(actorInput)
    let run = this.ownedRun(runID, actor)
    const records = this.resources.resourcesForRun(runID)
    if (records.length === 0) throw new Error("No owned resource registrations exist for this run")
    const coordinatorID = this.resources.coordinatorID()
    const execution = this.resources.execution(runID)
    if (!execution) throw new Error("Owned resource execution receipt was not committed")
    let status: OwnedProbeResult<never>["status"] = "replayed"
    if (run.lifecycle === "pending") {
      if (confirmation?.workerStopped !== true)
        throw new Error("Confirm the prior worker stopped before reconciling its pending probe")
      run = this.updateRun(run, actor, "interrupted", null, "pending")
      if (execution.phase !== "finished" && execution.phase !== "interrupted")
        this.resources.setExecutionPhase(runID, "interrupted")
      status = "interrupted"
    }
    const reconciled = this.reconcileRecords(records, coordinatorID)
    let cleanup: CleanupResult = { complete: true }
    if (
      run.lifecycle === "completed" ||
      run.lifecycle === "cancelled" ||
      run.lifecycle === "interrupted" ||
      execution.phase === "interrupted" ||
      execution.phase === "finished"
    ) {
      cleanup = this.cleanupRecords(runID, reconciled, coordinatorID)
      run = this.setProbeCleanup(runID, actor, cleanup.complete ? "complete" : "failed")
    }
    return {
      status,
      run,
      cleanupState: cleanup.complete ? "complete" : "failed",
      ...(cleanup.reason ? { reason: cleanup.reason } : {}),
    }
  }

  /** Retry only teardown; a prior behavior callback and verdict are untouched. */
  retryCleanup(runID: string, actorInput: unknown): OwnedProbeResult<never> {
    const actor = ProbeActorSchema.parse(actorInput)
    const run = this.ownedRun(runID, actor)
    const records = this.resources.resourcesForRun(runID)
    if (records.length === 0) throw new Error("No owned resource registrations exist for this run")
    const coordinatorID = this.resources.coordinatorID()
    if (run.lifecycle === "pending")
      throw new Error(
        "A pending probe requires explicit stopped-worker reconciliation before cleanup",
      )
    const reconciled = this.reconcileRecords(records, coordinatorID)
    const cleanup = this.cleanupRecords(runID, reconciled, coordinatorID)
    const updatedRun = this.setProbeCleanup(runID, actor, cleanup.complete ? "complete" : "failed")
    return {
      status: "replayed",
      run: updatedRun,
      cleanupState: cleanup.complete ? "complete" : "failed",
      ...(cleanup.reason ? { reason: cleanup.reason } : {}),
    }
  }

  private ownedRun(runID: string, actor: ProbeActor): ProbeRun {
    const run = this.probes.assertResourceActor(runID, actor)
    if (canonical(run.producer) !== canonical(actor))
      throw new Error("Owned resources require the original V2 probe producer")
    return run
  }

  private owner(run: ProbeRun): ResourceOwner {
    return {
      projectDirectory: this.repository.repository.projectDirectory,
      runID: run.runID,
      taskID: run.taskID,
      planID: run.planID,
      attemptID: run.attemptID,
      sessionID: run.sessionID,
      producer: run.producer,
      candidate: run.candidate,
      environment: run.environment,
    }
  }

  private createIfAbsent(resource: OwnedResource, coordinatorID: string): void {
    const observation = this.adapter.observe(resource, coordinatorID)
    if (observation.state === "owned" && observation.authoritative) {
      this.resources.setState(
        resource.resourceID,
        "active",
        "Adapter confirmed the owned fixture exists",
      )
      return
    }
    if (observation.state !== "absent" || !observation.authoritative) {
      this.resources.setState(resource.resourceID, "uncertain", observation.reason)
      throw new Error(observation.reason ?? "Fixture absence was not authoritative")
    }
    const creating = this.resources.setState(
      resource.resourceID,
      "creating",
      "Create intent was committed before adapter invocation",
    )
    this.adapter.create(creating, coordinatorID)
    const after = this.adapter.observe(resource, coordinatorID)
    if (after.state !== "owned" || !after.authoritative) {
      this.resources.setState(resource.resourceID, "uncertain", after.reason)
      throw new Error(after.reason ?? "Fixture creation was not authoritatively observed")
    }
    this.resources.setState(resource.resourceID, "active", "Adapter confirmed fixture creation")
  }

  private reconcileRecords(records: OwnedResource[], coordinatorID: string): OwnedResource[] {
    return records.map((original) => {
      let current = this.resources.resource(original.resourceID) ?? original
      if (current.state === "removed") {
        try {
          this.adapter.release(current, coordinatorID)
        } catch {
          // A stale/foreign sidecar remains a fail-closed reservation.
        }
        return current
      }
      const observation = this.adapter.observe(current, coordinatorID)
      if (
        !observation.authoritative ||
        observation.state === "unknown" ||
        observation.state === "foreign"
      ) {
        if (current.state !== "uncertain")
          current = this.resources.setState(current.resourceID, "uncertain", observation.reason)
        return current
      }
      if (observation.state === "owned") {
        if (current.state !== "active")
          current = this.resources.setState(
            current.resourceID,
            "active",
            "Restart observation confirmed owned fixture",
          )
        return current
      }

      if (current.state === "reserved") return current
      if (current.state === "creating")
        return this.resources.setState(
          current.resourceID,
          "reserved",
          "Authoritative absence permits a safe create retry",
        )
      try {
        // Release before the durable receipt. A failure keeps the SQLite claim.
        this.adapter.release(current, coordinatorID)
        return this.resources.setState(
          current.resourceID,
          "removed",
          "Authoritative adapter observation confirmed absence",
        )
      } catch (error) {
        if (current.state !== "uncertain")
          current = this.resources.setState(
            current.resourceID,
            "uncertain",
            this.errorMessage(error),
          )
        return current
      }
    })
  }

  private cleanupRecords(
    runID: string,
    records: OwnedResource[],
    coordinatorID: string,
  ): CleanupResult {
    const failures: string[] = []
    for (const original of records) {
      let current = this.resources.resource(original.resourceID) ?? original
      try {
        if (current.state === "removed") {
          this.adapter.release(current, coordinatorID)
          continue
        }
        let observation = this.adapter.observe(current, coordinatorID)
        if (
          !observation.authoritative ||
          observation.state === "unknown" ||
          observation.state === "foreign"
        ) {
          if (current.state !== "uncertain")
            current = this.resources.setState(current.resourceID, "uncertain", observation.reason)
          failures.push(`${current.name}: ${observation.reason ?? "ownership is uncertain"}`)
          continue
        }
        if (observation.state === "owned") {
          if (current.state !== "active")
            current = this.resources.setState(
              current.resourceID,
              "active",
              "Teardown observation confirmed ownership",
            )
          current = this.resources.setState(
            current.resourceID,
            "deleting",
            "Teardown intent was committed before adapter removal",
          )
          this.adapter.remove(current, coordinatorID)
          observation = this.adapter.observe(current, coordinatorID)
        }
        if (observation.state !== "absent" || !observation.authoritative) {
          if (current.state !== "uncertain")
            current = this.resources.setState(current.resourceID, "uncertain", observation.reason)
          failures.push(`${current.name}: teardown absence was not authoritative`)
          continue
        }
        this.adapter.release(current, coordinatorID)
        this.resources.setState(
          current.resourceID,
          "removed",
          "Adapter confirmed fixture absence and released its coordinator claim",
        )
      } catch (error) {
        const message = this.errorMessage(error)
        try {
          const latest = this.resources.resource(current.resourceID)
          if (latest && latest.state !== "removed" && latest.state !== "uncertain")
            this.resources.setState(latest.resourceID, "uncertain", message)
        } catch {
          // Preserve the first cleanup error; a durable prior claim remains held.
        }
        failures.push(`${current.name}: ${message}`)
      }
    }
    const latest = this.resources.resourcesForRun(runID)
    const complete =
      failures.length === 0 && latest.every((resource) => resource.state === "removed")
    return { complete, ...(failures.length ? { reason: failures.join("; ").slice(0, 1_000) } : {}) }
  }

  private setProbeCleanup(
    runID: string,
    actor: ProbeActor,
    cleanupState: "complete" | "failed",
  ): ProbeRun {
    const current = this.ownedRun(runID, actor)
    if (current.cleanupState === cleanupState) return current
    return this.updateRun(current, actor, current.lifecycle, current.verdict, cleanupState)
  }

  private updateRun(
    current: ProbeRun,
    actor: ProbeActor,
    lifecycle: ProbeRun["lifecycle"],
    verdict: ProbeRun["verdict"],
    cleanupState: ProbeRun["cleanupState"],
  ): ProbeRun {
    const result = this.probes.updateRun(
      {
        requestID: `owned-resource-${current.runID}-${current.version}-${lifecycle}-${verdict ?? "none"}-${cleanupState}`,
        runID: current.runID,
        expectedVersion: current.version,
        lifecycle,
        verdict,
        actions: current.actions,
        observations: current.observations,
        evidenceReferences: current.evidenceReferences,
        timing: current.timing,
        usage: current.usage,
        cleanupState,
      },
      actor,
    )
    if (result.status === "conflict") throw new Error(`Probe update conflict: ${result.message}`)
    return result.run
  }

  private fixture(resource: OwnedResource): OwnedFixture {
    return {
      resourceID: resource.resourceID,
      name: resource.name,
      path: this.adapter.path(resource),
      generation: resource.generation,
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 500) : "Unknown resource lifecycle error"
  }
}

/** Convenience constructor keeps the shared SQLite coordinator explicit. */
export function filesystemProbeLifecycle(
  repository: ResourceRepository,
  probes: ProbeRepository,
  rootDirectory: string,
): OwnedProbeLifecycle {
  return new OwnedProbeLifecycle(repository, probes, new FilesystemFixtureAdapter(rootDirectory))
}
