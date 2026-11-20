import { sessionTitle } from "./session-title.ts"
import { agentRouteReader, architectSessionModel } from "../models/agent-route-apply.ts"
import { architectContextTokens, routeArchitect, type ArchitectRoute } from "./architect-routing.ts"
import type { HostSession } from "./host.ts"
import { ModelPolicy } from "./schema.ts"
import type { PlanRow } from "./store.ts"
import type { ArchitectRoutingOptions } from "./architect-routing.ts"
import type { RuntimeCore } from "./runtime-core.ts"
import { sessionID } from "./runtime-helpers.ts"
import type { RuntimeJournal } from "./runtime-journal.ts"

/** What the ownership module reads from the coordinator. */
export type ArchitectOwnershipDeps = {
  architectRouting: ArchitectRoutingOptions
  journal: { outcome: RuntimeJournal["outcome"] }
}

/**
 * Who the plan's Architect session is: validity, owner adoption and wake-up, the session route
 * and model, and session titles. Moved out of `TaskRuntime` without rewriting; the private
 * aliases below keep the member bodies identical to what they were.
 */
export class ArchitectOwnership {
  private readonly architectRouting: ArchitectRoutingOptions
  private readonly outcome: RuntimeJournal["outcome"]

  constructor(
    private readonly core: RuntimeCore,
    deps: ArchitectOwnershipDeps,
  ) {
    this.architectRouting = deps.architectRouting
    this.outcome = (...args) => deps.journal.outcome(...args)
  }

  private get store() {
    return this.core.store
  }

  private get host() {
    return this.core.host
  }

  private get projectID() {
    return this.core.projectID
  }

  private get directory() {
    return this.core.directory
  }

  private get now() {
    return this.core.now
  }

  validArchitect(session: HostSession | null | undefined): session is HostSession {
    return Boolean(
      session &&
      !session.archived &&
      session.agent === "architect" &&
      session.projectID === this.projectID,
    )
  }
  async ensureArchitectOwner(
    plan: PlanRow,
    previous: HostSession | null | undefined,
    adopt = true,
  ): Promise<HostSession> {
    const current = await this.host.session(plan.owner)
    if (this.validArchitect(current)) return current
    // A user-set pause: never create, resume or fork an Architect session.
    if (this.store.architectContactPaused()) throw new Error("Architect contact is paused")

    let continuation = this.store.continuation(plan.id)
    let priorContinuation: HostSession | null = null
    if (continuation) {
      priorContinuation = await this.host.session(continuation.session_id)
      if (
        this.validArchitect(priorContinuation) &&
        this.matchesContinuation(priorContinuation, plan.id)
      ) {
        if (adopt) this.adoptArchitectOwner(plan, priorContinuation.id)
        return priorContinuation
      }
    }

    let next:
      | { session_id: string; parent_id: string | null; directory: string; model: string | null }
      | undefined
    if (!continuation || priorContinuation) {
      const source = previous?.projectID === this.projectID ? previous : current
      const model = source?.projectID === this.projectID ? source.model : undefined
      next = {
        session_id: sessionID(),
        parent_id: null,
        directory: this.directory,
        model: model ? JSON.stringify(model) : (continuation?.model ?? null),
      }
      continuation = continuation
        ? this.store.replaceContinuation(plan.id, continuation.session_id, next)
        : this.store.ensureContinuation(plan.id, next)
    }

    // A concurrent scheduler may already have selected a different stable ID.
    if (next && continuation.session_id !== next.session_id && continuation.generation > 1) {
      const adopted = await this.host.session(continuation.session_id)
      if (this.validArchitect(adopted) && this.matchesContinuation(adopted, plan.id)) {
        if (adopt) this.adoptArchitectOwner(plan, adopted.id)
        return adopted
      }
    }

    let session = await this.host.session(continuation.session_id)
    if (session && !this.matchesContinuation(session, plan.id))
      throw new Error("Native Architect continuation ID belongs to another session")
    if (!session) {
      try {
        await this.host.createArchitect({
          id: continuation.session_id,
          ...(continuation.parent_id ? { parentID: continuation.parent_id } : {}),
          directory: continuation.directory,
          ...(() => {
            const model = this.architectSessionModel(
              continuation.model ? JSON.parse(continuation.model) : undefined,
            )
            return model ? { model } : {}
          })(),
          title: this.sessionTitle(`continue ${plan.id.slice(0, 8)}`),
          planID: plan.id,
          sourceSessionID: plan.owner,
        })
      } catch (error) {
        const recovered = await this.host.session(continuation.session_id)
        if (!this.matchesContinuation(recovered, plan.id)) throw error
        session = recovered
      }
      session ??= await this.host.session(continuation.session_id)
    }
    if (!this.validArchitect(session) || !this.matchesContinuation(session, plan.id))
      throw new Error("Native Architect continuation is unavailable or foreign")
    this.store.record(plan.id, null, "ARCHITECT_CONTINUATION_READY", {
      sessionID: session.id,
      parentID: continuation.parent_id,
      generation: continuation.generation,
    })
    if (adopt) this.adoptArchitectOwner(plan, session.id)
    return session
  }
  adoptArchitectOwner(plan: PlanRow, sessionID: string) {
    this.store.atomic(() => {
      if (!this.store.adoptPlanOwner(plan.id, plan.owner, sessionID)) return
      // Persist the replacement's wake with ownership so a restart cannot split them.
      this.wakeRecoveredArchitect(plan.id)
    })
  }
  wakeRecoveredArchitect(planID: string) {
    const plan = this.store.plan(planID)!
    if (!["blocked", "accepted", "cleanup-blocked"].includes(plan.state)) return
    const pending = this.store.atomic((db) =>
      db
        .query<{ id: string }, [string]>(
          "SELECT id FROM runner_outbox WHERE plan_id=? AND state='pending' LIMIT 1",
        )
        .get(planID),
    )
    // A consumed notice does not mean its unresolved plan was repaired.
    if (!pending) this.outcome(planID, { status: plan.state, reason: plan.reason }, true)
  }
  matchesContinuation(session: HostSession | null | undefined, planID: string) {
    const continuation = this.store.continuation(planID)
    const listedPlans = session?.metadata?.lazersPlanIDs
    return (
      Boolean(continuation) &&
      session?.agent === "architect" &&
      session.projectID === this.projectID &&
      session.directory === this.directory &&
      session.parentID === (continuation?.parent_id ?? undefined) &&
      session.metadata?.lazersContinuation === true &&
      (session.metadata.lazersPlanID === planID ||
        (Array.isArray(listedPlans) && listedPlans.includes(planID)))
    )
  }
  /** `<CODE> · <text>`; `LAZERS` stands in until the project has a code. */
  sessionTitle(text: string): string {
    return sessionTitle(this.store.repository.projectCode() ?? "LAZERS", text)
  }
  /** The single routing decision: reuse a warm or small Architect, otherwise create a fresh one. */
  architectRoute(session: HostSession | null | undefined): ArchitectRoute {
    return routeArchitect(
      this.validArchitect(session) ? session : null,
      this.now(),
      this.architectRouting,
    )
  }
  /** Record the routing decision once per change, with its reason, before acting on it. */
  recordArchitectRoute(
    plan: PlanRow,
    route: ArchitectRoute,
    session: HostSession | null | undefined,
  ) {
    const previous = this.store.latestTransition<{ sessionID: string | null; reason: string }>(
      plan.id,
      null,
      "ARCHITECT_ROUTED",
    )
    if (previous?.sessionID === route.sessionID && previous.reason === route.reason) return
    this.store.record(plan.id, null, "ARCHITECT_ROUTED", {
      action: route.action,
      reason: route.reason,
      sessionID: route.sessionID,
      owner: plan.owner,
      contextTokens: session ? architectContextTokens(session) : null,
      cacheWindowMs: this.architectRouting.architectCacheWindowMs,
      reuseMaxContextTokens: this.architectRouting.architectReuseMaxContextTokens,
    })
  }
  /**
   * The one model decision for an Architect session LAZERS creates. A renewal records it and the
   * host creates exactly it, so the successor check compares the session with what was asked for.
   */
  architectSessionModel(carried: ModelPolicy | undefined) {
    return architectSessionModel(agentRouteReader(this.store.repository)("architect"), carried)
  }
  architectWaitingForHuman(session: HostSession) {
    return (session.pendingForms ?? 0) > 0 || (session.pendingPermissions ?? 0) > 0
  }
}
