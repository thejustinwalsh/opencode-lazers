import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fingerprint } from "../identity.ts"
import type { TaskProposal } from "../task.ts"
import { artifactExists, commitArtifact, artifactUnchanged, git, runCheck } from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import type { HostSession, RunnerHost } from "./host.ts"
import { CommandInput, ModelPolicy, PlanInput } from "./schema.ts"
import type { PlanRow, NodeRow, AttemptRow, EffectRow } from "./store.ts"
import { RunnerStore } from "./store.ts"

const terminal = new Set([
  "accepted",
  "failed",
  "cancelled",
  "exhausted",
  "incorporated",
  "integrated",
  "cleanup-blocked",
])
const messageID = () => `msg_${crypto.randomUUID().replaceAll("-", "")}`
const sessionID = () => `ses_${crypto.randomUUID().replaceAll("-", "")}`
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class TaskRuntime {
  readonly owner = crypto.randomUUID()
  private running = false
  private stopped = false
  constructor(
    readonly store: RunnerStore,
    readonly host: RunnerHost,
    readonly projectID: string,
  ) {}
  get directory() {
    return this.store.repository.projectDirectory
  }
  get dataDirectory() {
    return join(dirname(this.store.repository.path), "runner")
  }

  async command(input: unknown, caller: string) {
    const command = CommandInput.parse(input)
    const prior = this.store.priorCommand<unknown>(command.requestID, { command, caller })
    if (prior !== undefined) return prior
    // Resolve host facts before the transaction, then recheck durable versions within it.
    const old = this.store.plan(command.planID)
    if (!old) throw new Error("Plan not found")
    const target = command.action === "reassign" ? command.targetSessionID : old.owner
    let ownerSession: HostSession | null | undefined
    if (["run", "reassign", "reconcile", "resume", "retry"].includes(command.action)) {
      if (!target) throw new Error("Target session required")
      ownerSession = await this.host.session(target)
    }
    const skills =
      command.action === "run"
        ? await this.host.skills(old.owner, [
            ...new Set(
              this.store
                .nodes(old.id)
                .flatMap((n) => this.store.repository.get(n.task_id)!.proposal.requirements.skills),
            ),
          ])
        : []
    const result = this.store.command(command.requestID, { command, caller }, (db) => {
      const plan = this.store.plan(command.planID)!
      if (plan.version !== command.expectedVersion)
        throw new Error(`Stale plan version; current ${plan.version}`)
      if (caller !== plan.owner && !["audit", "reassign"].includes(command.action))
        throw new Error("Only the plan owner may change execution")
      if (command.action === "integrated") {
        if (!["accepted", "cleanup-blocked"].includes(plan.state) || !plan.artifact)
          throw new Error("Only an accepted result can be integrated")
        if (command.artifact !== plan.artifact || !command.targetBranch || !command.reason)
          throw new Error("Record the accepted artifact, reviewed targetBranch and reason")
        if (git(this.directory, ["branch", "--show-current"]) !== command.targetBranch)
          throw new Error("The current checkout is not the reviewed target branch")
        git(this.directory, ["merge-base", "--is-ancestor", plan.artifact, "HEAD"])
        this.store.record(plan.id, null, "INTEGRATION_RECORDED", {
          artifact: plan.artifact,
          branch: command.targetBranch,
          head: git(this.directory, ["rev-parse", "HEAD"]),
          reason: command.reason,
        })
        db.query(
          "UPDATE runner_plans SET state='cleaning',reason=NULL,version=version+1 WHERE id=?",
        ).run(plan.id)
        return { status: "cleanup-requested", version: this.store.plan(plan.id)!.version }
      }
      if (command.action === "audit")
        return { status: "audited", ...this.store.audit(), version: plan.version }
      if (command.action === "reassign") {
        if (!ownerSession || ownerSession.archived || ownerSession.projectID !== this.projectID)
          throw new Error("Reassignment needs an unarchived same-project owner")
        db.query("UPDATE runner_plans SET owner=?,version=version+1 WHERE id=?").run(
          ownerSession.id,
          plan.id,
        )
        this.store.record(plan.id, null, "OWNER_REASSIGNED", {
          from: plan.owner,
          to: ownerSession.id,
          reason: command.reason,
        })
        return { status: "reassigned", version: plan.version + 1 }
      }
      if (command.action === "cancel") {
        if (terminal.has(plan.state)) throw new Error("Plan has ended")
        // Stop admission now. In-flight work remains running until interruption is proven.
        db.query(
          "UPDATE runner_plans SET state='cancelling',reason='Cancellation requested',version=version+1 WHERE id=?",
        ).run(plan.id)
        for (const node of this.store.nodes(plan.id))
          if (!terminal.has(node.state) && node.state !== "running" && node.state !== "verifying")
            this.store.move(plan.id, node.task_id, "CANCEL")
        this.store.record(plan.id, null, "CANCEL_REQUESTED", { caller })
        return { status: "cancelling", version: this.store.plan(plan.id)!.version }
      }
      if (command.action === "human-evidence") {
        if (!command.taskID || !command.assertionID || !command.artifact || !command.reason)
          throw new Error("Human evidence requires task, assertion, exact artifact and decision")
        const node = this.store.nodes(plan.id).find((n) => n.task_id === command.taskID)
        const assertion = this.store.repository
          .get(command.taskID)
          ?.proposal.acceptance.find((a) => a.id === command.assertionID)
        if (
          !node ||
          node.artifact !== command.artifact ||
          !assertion?.evidence.some((e) => e.kind === "human")
        )
          throw new Error("Human evidence does not bind to the current assertion/artifact")
        db.query("INSERT INTO runner_evidence VALUES(?,?,?,?,?,'human',?,?,?)").run(
          crypto.randomUUID(),
          plan.id,
          node.task_id,
          null,
          assertion.id,
          command.artifact,
          JSON.stringify({ decision: command.reason, caller }),
          Date.now(),
        )
        this.store.record(plan.id, node.task_id, "HUMAN_EVIDENCE", {
          assertionID: assertion.id,
          artifact: command.artifact,
        })
        return { status: "recorded", version: this.store.plan(plan.id)!.version }
      }
      if (command.action === "resume" || command.action === "retry") {
        const retry = command.action === "retry"
        if (!ownerSession || ownerSession.archived) throw new Error("Owner unavailable")
        if (!command.taskID || !command.reason) throw new Error("Resume requires taskID and reason")
        const node = this.store.nodes(plan.id).find((n) => n.task_id === command.taskID)
        const attempt = this.store
          .attempts(plan.id)
          .filter((a) => a.task_id === command.taskID)
          .at(-1)
        if (
          !["blocked", "cancelled", "failed"].includes(plan.state) ||
          !node ||
          !["exhausted", "cancelled", "running", "failed", "blocked"].includes(node.state) ||
          !attempt ||
          !["exhausted", "cancelled", "preparing", "failed"].includes(attempt.state)
        )
          throw new Error("Only an exhausted or cancelled, stopped attempt can resume")
        if (
          this.store
            .effects(plan.id)
            .some((effect) => ["intended", "uncertain"].includes(effect.state))
        )
          throw new Error("Reconcile uncertain effects first")
        if (retry) this.store.move(plan.id, node.task_id, "RETRY", command.reason)
        else if (node.state !== "running")
          this.store.move(plan.id, node.task_id, "RESUME", command.reason)
        if (command.workspaceMode === "shared") {
          const source = command.baseCommit ?? git(this.directory, ["rev-parse", "HEAD"])
          git(this.directory, ["merge-base", "--is-ancestor", source, "HEAD"])
          if (!retry)
            db.query("UPDATE runner_attempts SET workspace=?,base_commit=? WHERE id=?").run(
              this.directory,
              source,
              attempt.id,
            )
          const policy = JSON.parse(attempt.policy)
          policy.workspaceMode = "shared"
          policy.source = source
          const revised = PlanInput.parse({
            ...JSON.parse(plan.body),
            workspaceMode: "shared",
            baseCommit: source,
          })
          db.query("UPDATE runner_plans SET body=?,revision=revision+1 WHERE id=?").run(
            JSON.stringify(revised),
            plan.id,
          )
          db.query("INSERT INTO runner_plan_revisions VALUES(?,?,?,?,?)").run(
            plan.id,
            plan.revision + 1,
            JSON.stringify(revised),
            plan.owner,
            Date.now(),
          )
          if (!retry)
            db.query("UPDATE runner_attempts SET policy=? WHERE id=?").run(
              JSON.stringify(policy),
              attempt.id,
            )
          this.store.record(plan.id, node.task_id, "WORKSPACE_SELECTED", {
            attemptID: attempt.id,
            from: attempt.workspace,
            directory: this.directory,
            source,
            mode: "shared",
            reason: command.reason,
          })
        }
        if (retry)
          db.query(
            "UPDATE runner_attempts SET state='cancelled' WHERE id=? AND state='preparing'",
          ).run(attempt.id)
        else
          db.query("UPDATE runner_attempts SET state='preparing',message_id=? WHERE id=?").run(
            messageID(),
            attempt.id,
          )
        db.query(
          "UPDATE runner_plans SET state='running',reason=NULL,version=version+1 WHERE id=?",
        ).run(plan.id)
        this.store.record(plan.id, node.task_id, retry ? "RETRY_REQUESTED" : "ATTEMPT_RESUMED", {
          attemptID: attempt.id,
          reason: command.reason,
          usageRetained: true,
          budget: null,
        })
        return {
          status: retry ? "retrying" : "resuming",
          version: this.store.plan(plan.id)!.version,
        }
      }
      if (command.action === "reconcile") {
        if (!ownerSession || ownerSession.archived) throw new Error("Owner unavailable")
        if (this.store.effects(plan.id).some((e) => ["intended", "uncertain"].includes(e.state)))
          return {
            status: "blocked",
            reason: "Uncertain effects require conclusive host/artifact evidence",
            version: plan.version,
          }
        if (plan.state === "blocked") {
          db.query(
            "UPDATE runner_plans SET state='running',reason=NULL,version=version+1 WHERE id=?",
          ).run(plan.id)
          for (const node of this.store.nodes(plan.id))
            if (
              node.state === "blocked" &&
              !this.store.attempts(plan.id).some((a) => a.task_id === node.task_id)
            )
              this.store.move(plan.id, node.task_id, "RECONCILE")
        }
        this.store.record(plan.id, null, "RECONCILE_REQUESTED", { caller })
        return { status: "reconciling", version: this.store.plan(plan.id)!.version }
      }
      if (plan.state !== "draft" && plan.state !== "blocked")
        throw new Error("Execution already requested or ended")
      if (this.store.attempts(plan.id).length)
        throw new Error(
          "Existing execution must be reconciled; admission cannot replace its policy",
        )
      if (!ownerSession || ownerSession.archived)
        return this.hold(plan, "Owner is missing or archived")
      if (ownerSession.projectID !== this.projectID) throw new Error("Foreign owner session")
      const model = ModelPolicy.parse(ownerSession.model)
      if (model.providerID !== "openai")
        return this.hold(
          plan,
          "Initial execution requires the authorized connected OpenAI subscription model; no provider fallback",
        )
      const proposal = PlanInput.parse(JSON.parse(plan.body))
      try {
        if (
          git(this.directory, ["rev-parse", `${proposal.baseCommit}^{commit}`]) !==
          proposal.baseCommit
        )
          throw new Error("Base mismatch")
      } catch (error) {
        return this.hold(plan, `Unavailable committed source baseline: ${errorText(error)}`)
      }
      const audit = this.store.audit()
      const ids = new Set(proposal.nodes.map((n) => n.taskID))
      const conflicts = audit.findings.filter(
        (f) =>
          ["exact-content", "scope-overlap"].includes(f.code) &&
          f.taskIDs.some((id) => ids.has(id)),
      )
      if (conflicts.length)
        return this.hold(
          plan,
          `Unresolved overlap findings: ${conflicts.map((f) => f.id).join(", ")}`,
        )
      const required = [
        ...new Set(
          this.store
            .nodes(plan.id)
            .flatMap((n) => this.store.repository.get(n.task_id)!.proposal.requirements.skills),
        ),
      ]
      if (required.some((id) => !skills.some((s) => s.id === id)))
        return this.hold(plan, "Required skill unavailable")
      db.query(
        "UPDATE runner_plans SET state='running',model=?,reason=NULL,version=version+1 WHERE id=?",
      ).run(JSON.stringify(model), plan.id)
      this.store.record(plan.id, null, "ADMITTED", {
        model,
        skills: skills.map(({ content: _content, ...source }) => source),
        auditWatermark: audit.watermark,
        source: proposal.baseCommit,
        enforcement: {
          budget: "unconfigured; historical proposed limits are not execution policy",
          tokens: "measured usage only",
          cost: "API-equivalent price unavailable until resolved; never treated as zero",
          tools: "measured usage only",
          repairs: "one bounded verification repair by default",
        },
      })
      return { status: "running", planID: plan.id, version: this.store.plan(plan.id)!.version }
    })
    return result
  }

  private hold(plan: PlanRow, reason: string) {
    this.store.atomic((db) =>
      db
        .query("UPDATE runner_plans SET state='blocked',reason=?,version=version+1 WHERE id=?")
        .run(reason, plan.id),
    )
    this.store.record(plan.id, null, "BLOCKED", { reason })
    this.outcome(
      plan.id,
      { status: "blocked", reason, allowedActions: ["audit", "reconcile", "cancel"] },
      true,
    )
    return {
      status: "blocked",
      reason,
      planID: plan.id,
      version: this.store.plan(plan.id)!.version,
    }
  }
  private outcome(planID: string, payload: unknown, resume: boolean) {
    const plan = this.store.plan(planID)!
    const full = {
      planID,
      planRevision: plan.revision,
      version: plan.version,
      ...(payload as object),
    }
    const id = fingerprint(full)
    this.store.atomic((db) => {
      db.query("INSERT OR IGNORE INTO runner_outbox VALUES(?,?,?,?,?,'pending',?)").run(
        id,
        planID,
        plan.owner,
        messageID(),
        JSON.stringify(full),
        Number(resume),
      )
      this.store.repository.changed()
    })
  }
  private effect(
    planID: string,
    taskID: string | null,
    attemptID: string | null,
    kind: string,
    payload: unknown,
    fence: number,
  ): EffectRow {
    const id = fingerprint({ planID, taskID, attemptID, kind, payload })
    return this.store.fenced(this.owner, fence, (db) => {
      const existing = db
        .query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE id=?")
        .get(id)
      if (existing) throw new Error(`Existing ${kind} effect must be reconciled, never replayed`)
      db.query("INSERT INTO runner_effects VALUES(?,?,?,?,?,'intended',?,NULL,?)").run(
        id,
        planID,
        taskID,
        attemptID,
        kind,
        JSON.stringify(payload),
        fence,
      )
      this.store.record(planID, taskID, "EFFECT_INTENDED", { effectID: id, kind, attemptID })
      return db.query<EffectRow, [string]>("SELECT * FROM runner_effects WHERE id=?").get(id)!
    })
  }
  private receipt(effect: EffectRow, receipt: unknown, fence: number) {
    this.store.fenced(this.owner, fence, (db) => {
      db.query(
        "UPDATE runner_effects SET state='completed',receipt=? WHERE id=? AND state IN ('intended','uncertain')",
      ).run(JSON.stringify(receipt), effect.id)
      this.store.record(effect.plan_id, effect.task_id, "EFFECT_COMPLETED", {
        effectID: effect.id,
        kind: effect.kind,
      })
    })
  }
  private uncertain(effect: EffectRow, error: unknown, fence: number) {
    this.store.fenced(this.owner, fence, (db) =>
      db
        .query("UPDATE runner_effects SET state='uncertain',receipt=? WHERE id=?")
        .run(JSON.stringify({ error: errorText(error) }), effect.id),
    )
    const plan = this.store.plan(effect.plan_id)!
    this.hold(plan, `Recovery uncertain for ${effect.kind} ${effect.id}: ${errorText(error)}`)
  }

  async tick() {
    if (this.running || this.stopped) return
    this.running = true
    const fence = this.store.claim(this.owner)
    if (fence === null) {
      this.running = false
      return
    }
    const heartbeat = setInterval(() => {
      this.store.renew(this.owner, fence)
    }, 10000)
    try {
      // A lease only selects a reconciler; it never proves an old side effect stopped.
      for (const plan of this.store
        .plans()
        .filter((p) => !terminal.has(p.state) && p.state !== "draft")) {
        await this.step(plan, fence)
      }
      await this.deliver(fence)
    } finally {
      clearInterval(heartbeat)
      this.running = false
    }
  }
  stop() {
    this.stopped = true
  }

  private async step(plan: PlanRow, fence: number) {
    if (plan.state === "cleaning") {
      await this.cleanupWorktrees(plan, fence)
      return
    }
    const owner = await this.host.session(plan.owner)
    if (!owner || owner.archived) {
      if (plan.reason !== "Owner is missing or archived")
        this.hold(plan, "Owner is missing or archived")
      return
    }
    const pending = this.store
      .effects(plan.id)
      .find((e) => ["intended", "uncertain"].includes(e.state))
    if (pending) {
      await this.reconcileEffect(pending, fence)
      return
    }
    const active = this.store
      .attempts(plan.id)
      .find((a) => ["preparing", "running", "verifying"].includes(a.state))
    if (plan.state === "cancelling") {
      if (active) {
        const session = await this.host.session(active.session_id)
        if (session?.busy) {
          await this.host.interrupt(active.session_id)
          return
        }
        this.store.fenced(this.owner, fence, (db) =>
          db.query("UPDATE runner_attempts SET state='cancelled' WHERE id=?").run(active.id),
        )
        const node = this.store.nodes(plan.id).find((n) => n.task_id === active.task_id)!
        if (!terminal.has(node.state)) this.store.move(plan.id, node.task_id, "CANCEL")
      }
      this.store.atomic((db) =>
        db
          .query("UPDATE runner_plans SET state='cancelled',version=version+1 WHERE id=?")
          .run(plan.id),
      )
      this.outcome(plan.id, { status: "cancelled" }, true)
      return
    }
    if (plan.state === "blocked") return
    if (active) {
      await this.advanceAttempt(plan, active, fence)
      return
    }
    // Across all plans: one active implementation/repair slot per canonical project.
    if (
      this.store
        .plans()
        .some(
          (p) =>
            p.id !== plan.id &&
            this.store
              .attempts(p.id)
              .some((a) => ["preparing", "running", "verifying"].includes(a.state)),
        )
    )
      return
    const nodes = this.store.nodes(plan.id)
    const next = nodes.find(
      (n) =>
        ["queued", "ready"].includes(n.state) &&
        this.store.execution(n.task_id)!.waitingOn.length === 0,
    )
    if (next) {
      await this.dispatch(plan, next, fence)
      return
    }
    const failed = nodes.find((n) =>
      ["failed", "cancelled", "exhausted", "blocked"].includes(n.state),
    )
    if (failed) {
      this.hold(plan, `Task ${failed.task_id}: ${failed.reason ?? failed.state}`)
      return
    }
    if (nodes.every((n) => n.state === "accepted" || n.state === "incorporated"))
      await this.finish(plan, fence)
  }

  private async dispatch(plan: PlanRow, node: NodeRow, fence: number) {
    const task = this.store.repository.get(node.task_id)!
    const attempts = this.store.attempts(plan.id).filter((a) => a.task_id === task.id)
    const first = attempts[0]
    const audit = this.store.audit()
    if (
      audit.findings.some(
        (f) => ["exact-content", "scope-overlap"].includes(f.code) && f.taskIDs.includes(task.id),
      )
    ) {
      this.hold(plan, "Overlap audit changed before dispatch")
      return
    }
    const input = PlanInput.parse(JSON.parse(plan.body))
    if (JSON.parse(plan.body).workspaceMode === undefined && attempts.length)
      input.workspaceMode = attempts.at(-1)!.workspace === this.directory ? "shared" : "isolated"
    const skills = await this.host.skills(plan.owner, task.proposal.requirements.skills)
    if (skills.length !== task.proposal.requirements.skills.length) {
      this.hold(plan, "Required skill unavailable at dispatch")
      return
    }
    const id = crypto.randomUUID()
    // Serial integration uses each accepted prior artifact; dependencies remain explicit readiness gates.
    const previous = this.store
      .nodes(plan.id)
      .filter((n) => n.ordinal < node.ordinal && n.state === "accepted")
      .at(-1)
    const base =
      attempts.at(-1)?.artifact ??
      previous?.artifact ??
      (input.workspaceMode === "shared"
        ? git(this.directory, ["rev-parse", "HEAD"])
        : input.baseCommit)
    const workspace =
      input.workspaceMode === "shared" ? this.directory : join(this.dataDirectory, "worktrees", id)
    const text = JSON.stringify({
      taskID: task.id,
      revision: task.revision,
      specification: task.proposal,
      skills,
      source: base,
      previousAttempt: first
        ? { id: attempts.at(-1)!.id, evidence: this.store.detail(plan.id).evidence }
        : null,
    })
    const policy = {
      agent: "lazers-implementor",
      workspaceMode: input.workspaceMode,
      model: ModelPolicy.parse(JSON.parse(plan.model!)),
      source: base,
      context: text,
      skills: skills.map(({ content: _content, ...s }) => s),
      budget: null,
      repairAttempt: this.store.atomic(
        (db) =>
          db
            .query<{ event: string }, [string, string]>(
              "SELECT event FROM runner_transitions WHERE plan_id=? AND task_id=? ORDER BY id DESC LIMIT 1",
            )
            .get(plan.id, task.id)?.event === "REPAIR",
      ),
      toolPolicy: "inherit host/user/project; delegation forbidden",
      costEstimate: { status: "unavailable", currency: "USD", kind: "equivalent-api" },
    }
    let attempt!: AttemptRow
    this.store.fenced(this.owner, fence, (db) => {
      if (node.state === "queued") this.store.move(plan.id, task.id, "READY")
      this.store.move(plan.id, task.id, "DISPATCH")
      db.query(
        "INSERT INTO runner_attempts(id,plan_id,task_id,number,session_id,message_id,workspace,base_commit,policy,state,started_at) VALUES(?,?,?,?,?,?,?,?,?,'preparing',?)",
      ).run(
        id,
        plan.id,
        task.id,
        attempts.length + 1,
        sessionID(),
        messageID(),
        workspace,
        base,
        JSON.stringify(policy),
        Date.now(),
      )
      attempt = this.store.attempts(plan.id).find((a) => a.id === id)!
    })
    if (input.workspaceMode === "shared") {
      await this.prepareWorker(plan, attempt, fence)
      return
    }
    const effect = this.effect(plan.id, task.id, id, "worktree", { workspace, base }, fence)
    try {
      const actual = await this.host.worktree({ directory: workspace, base })
      if (git(actual, ["rev-parse", "HEAD"]) !== base)
        throw new Error("Host worktree did not use the admitted starting revision")
      this.store.fenced(this.owner, fence, (db) =>
        db.query("UPDATE runner_attempts SET workspace=? WHERE id=?").run(actual, id),
      )
      attempt.workspace = actual
      this.receipt(effect, { workspace: actual, base }, fence)
    } catch (error) {
      this.uncertain(effect, error, fence)
      return
    }
    await this.prepareWorker(plan, attempt, fence)
  }
  private async prepareWorker(plan: PlanRow, attempt: AttemptRow, fence: number) {
    const policy = JSON.parse(attempt.policy)
    const existing = this.store.effects(plan.id)
    if (!existing.some((e) => e.attempt_id === attempt.id && e.kind === "session")) {
      const effect = this.effect(
        plan.id,
        attempt.task_id,
        attempt.id,
        "session",
        { sessionID: attempt.session_id },
        fence,
      )
      try {
        await this.host.create({
          id: attempt.session_id,
          parentID: plan.owner,
          agent: "lazers-implementor",
          model: ModelPolicy.parse(policy.model),
          directory: attempt.workspace,
          title: `LAZERS · ${this.store.repository.get(attempt.task_id)!.proposal.objective.slice(0, 100)}`,
          attemptID: attempt.id,
        })
        this.receipt(effect, { sessionID: attempt.session_id }, fence)
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    if (
      !existing.some(
        (e) =>
          e.attempt_id === attempt.id &&
          e.kind === "prompt" &&
          JSON.parse(e.payload).messageID === attempt.message_id,
      )
    ) {
      if (!policy.packet) {
        policy.packet = { recipe: "task-tool/1", taskID: attempt.task_id, tool: "lazers_get_task" }
        this.store.fenced(this.owner, fence, (db) => {
          db.query("UPDATE runner_attempts SET policy=? WHERE id=?").run(
            JSON.stringify(policy),
            attempt.id,
          )
          this.store.record(plan.id, attempt.task_id, "CONTEXT_RESOLVED", {
            attemptID: attempt.id,
            packet: policy.packet,
          })
        })
      }
      const effect = this.effect(
        plan.id,
        attempt.task_id,
        attempt.id,
        "prompt",
        {
          sessionID: attempt.session_id,
          messageID: attempt.message_id,
          workspace: attempt.workspace,
        },
        fence,
      )
      try {
        await this.host.prompt({
          sessionID: attempt.session_id,
          id: attempt.message_id,
          directory: attempt.workspace,
          text: `Implement LAZERS task ${attempt.task_id} in ${attempt.workspace}. Fetch revision 1 with lazers_get_task before editing. The tool returns your objective, write scope, acceptance criteria, checks and repository references. Read the local AGENTS.md and relevant source; use focused repository reads as needed. Preserve existing task edits, finish the implementation, run the specified checks, commit your changes, and report the result and unresolved issues in prose. Do not print the task JSON or delegate. This is a continuation when earlier messages exist; the assigned worktree is authoritative.`,
        })
        this.receipt(
          effect,
          {
            messageID: attempt.message_id,
            taskID: attempt.task_id,
            instructions: "prose; lazers_get_task",
          },
          fence,
        )
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    this.store.fenced(this.owner, fence, (db) =>
      db.query("UPDATE runner_attempts SET state='running' WHERE id=?").run(attempt.id),
    )
  }

  private async advanceAttempt(plan: PlanRow, attempt: AttemptRow, fence: number) {
    if (attempt.state === "preparing") {
      await this.prepareWorker(plan, attempt, fence)
      return
    }
    const session = await this.host.session(attempt.session_id)
    if (!session) {
      this.hold(plan, "Owned worker session definitively missing")
      return
    }
    const task = this.store.repository.get(attempt.task_id)!
    this.store.fenced(this.owner, fence, (db) =>
      db
        .query("UPDATE runner_attempts SET token_count=?,cost=?,tool_count=? WHERE id=?")
        .run(session.tokens, session.cost, Math.max(session.tools, attempt.tool_count), attempt.id),
    )
    if (session.busy || !session.outcome) return
    if (session.outcome !== "succeeded") {
      this.failAttempt(plan, attempt, `Worker ${session.outcome}`)
      return
    }
    if (attempt.state === "running") {
      this.store.move(plan.id, task.id, "VERIFY")
      this.store.atomic((db) =>
        db.query("UPDATE runner_attempts SET state='verifying' WHERE id=?").run(attempt.id),
      )
    }
    await this.verify(plan, attempt, task.proposal, fence)
  }

  private async verify(plan: PlanRow, attempt: AttemptRow, proposal: TaskProposal, fence: number) {
    let artifact
    try {
      artifact = commitArtifact(
        attempt.workspace,
        attempt.base_commit,
        proposal.writeScope,
        attempt.workspace !== this.directory,
      )
    } catch (error) {
      this.failAttempt(plan, attempt, errorText(error))
      return
    }
    this.store.fenced(this.owner, fence, (db) => {
      db.query("UPDATE runner_attempts SET artifact=? WHERE id=?").run(artifact.commit, attempt.id)
      db.query("UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=?").run(
        artifact.commit,
        plan.id,
        attempt.task_id,
      )
    })
    const receipts: CheckReceipt[] = []
    for (const check of proposal.verification) {
      const known = this.store
        .effects(plan.id)
        .find((e) => e.attempt_id === attempt.id && e.kind === `verify:${check.id}`)
      if (known?.state === "completed") {
        receipts.push(JSON.parse(known.receipt!).check)
        continue
      }
      const receiptPath = join(this.dataDirectory, "receipts", attempt.id, `${check.id}.json`)
      const effect = this.effect(
        plan.id,
        attempt.task_id,
        attempt.id,
        `verify:${check.id}`,
        {
          check,
          workspace: attempt.workspace,
          artifact: artifact.commit,
          identity: artifact.identity,
          receiptPath,
        },
        fence,
      )
      try {
        const result = await runCheck(attempt.workspace, artifact.commit, check, receiptPath)
        this.receipt(effect, { check: result }, fence)
        this.store.atomic((db) =>
          db
            .query("INSERT INTO runner_evidence VALUES(?,?,?,?,NULL,'verification',?,?,?)")
            .run(
              effect.id,
              plan.id,
              attempt.task_id,
              attempt.id,
              artifact.commit,
              JSON.stringify(result),
              Date.now(),
            ),
        )
        receipts.push(result)
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    const failure = receipts.find(
      (r) =>
        r.exitCode !== 0 || r.timedOut || !r.unchanged || r.inputIdentity !== artifact.identity,
    )
    if (failure) {
      this.failAttempt(plan, attempt, `Verification ${failure.id} failed or changed its inputs`)
      return
    }
    const missing = this.missingEvidence(
      plan.id,
      attempt.task_id,
      artifact.commit,
      attempt.workspace,
      proposal.acceptance,
      receipts,
    )
    if (missing.length) {
      this.hold(plan, `Required evidence missing: ${missing.join(", ")}`)
      return
    }
    if (!artifactUnchanged(attempt.workspace, artifact.commit)) {
      this.failAttempt(plan, attempt, "Artifact changed after verification")
      return
    }
    this.store.fenced(this.owner, fence, (db) => {
      db.query("UPDATE runner_attempts SET state='accepted' WHERE id=?").run(attempt.id)
      this.store.move(plan.id, attempt.task_id, "ACCEPT")
      this.store.record(plan.id, attempt.task_id, "ARTIFACT_ACCEPTED", artifact)
      this.outcome(
        plan.id,
        {
          status: "task-accepted",
          taskID: attempt.task_id,
          attemptID: attempt.id,
          artifact: artifact.commit,
          evidence: receipts.map((r) => r.id),
        },
        false,
      )
    })
  }
  private missingEvidence(
    planID: string,
    taskID: string | null,
    artifact: string,
    workspace: string,
    assertions: TaskProposal["acceptance"],
    receipts: CheckReceipt[],
  ) {
    const missing: string[] = []
    for (const assertion of assertions)
      for (const evidence of assertion.evidence) {
        if (
          evidence.kind === "verification" &&
          !receipts.some(
            (r) =>
              r.id === evidence.verificationID && r.exitCode === 0 && !r.timedOut && r.unchanged,
          )
        )
          missing.push(assertion.id)
        if (evidence.kind === "artifact" && !artifactExists(workspace, evidence.reference))
          missing.push(`${assertion.id}:${evidence.reference}`)
        if (evidence.kind === "human") {
          const found = this.store.atomic((db) =>
            db
              .query(
                "SELECT id FROM runner_evidence WHERE plan_id=? AND task_id IS ? AND kind='human' AND assertion_id=? AND artifact=?",
              )
              .get(planID, taskID, assertion.id, artifact),
          )
          if (!found) missing.push(`${assertion.id}:human`)
        }
      }
    return missing
  }
  private failAttempt(plan: PlanRow, attempt: AttemptRow, reason: string) {
    const task = this.store.repository.get(attempt.task_id)!
    const node = this.store.nodes(plan.id).find((n) => n.task_id === task.id)!
    this.store.atomic((db) => {
      db.query("UPDATE runner_attempts SET state='failed' WHERE id=?").run(attempt.id)
      if (
        node.state === "verifying" &&
        (task.proposal.limits?.maxRepairAttempts ?? 1) > 0 &&
        !JSON.parse(attempt.policy).repairAttempt
      )
        this.store.move(plan.id, task.id, "REPAIR", reason)
      else this.store.move(plan.id, task.id, "FAIL", reason)
    })
    if (this.store.execution(task.id)?.state === "failed") this.hold(plan, reason)
  }
  private async finish(plan: PlanRow, fence: number) {
    const input = PlanInput.parse(JSON.parse(plan.body))
    const artifact =
      this.store
        .nodes(plan.id)
        .filter((n) => n.artifact)
        .at(-1)?.artifact ?? input.baseCommit
    // Serial integration is already present in the last accepted worker's workspace.
    // Reuse it for combined checks instead of allocating another worktree.
    const workspace =
      this.store
        .attempts(plan.id)
        .filter((attempt) => attempt.artifact === artifact)
        .at(-1)?.workspace ?? this.directory
    const receipts: CheckReceipt[] = []
    for (const check of input.verification) {
      const existing = this.store
        .effects(plan.id)
        .find((e) => e.kind === `graph-verify:${check.id}`)
      if (existing?.state === "completed") {
        receipts.push(JSON.parse(existing.receipt!).check)
        continue
      }
      const receiptPath = join(this.dataDirectory, "receipts", plan.id, `${check.id}.json`)
      const effect = this.effect(
        plan.id,
        null,
        null,
        `graph-verify:${check.id}`,
        { workspace, artifact, identity: artifact, check, receiptPath },
        fence,
      )
      try {
        const result = await runCheck(workspace, artifact, check, receiptPath)
        this.receipt(effect, { check: result }, fence)
        receipts.push(result)
      } catch (error) {
        this.uncertain(effect, error, fence)
        return
      }
    }
    if (receipts.some((r) => r.exitCode !== 0 || r.timedOut || !r.unchanged)) {
      this.hold(plan, "Combined artifact verification failed")
      return
    }
    const missing = this.missingEvidence(
      plan.id,
      null,
      artifact,
      workspace,
      input.acceptance,
      receipts,
    )
    if (missing.length) {
      this.hold(plan, `Combined artifact evidence missing: ${missing.join(", ")}`)
      return
    }
    this.store.fenced(this.owner, fence, (db) => {
      db.query(
        "UPDATE runner_plans SET state='accepted',artifact=?,version=version+1 WHERE id=?",
      ).run(artifact, plan.id)
      this.store.record(plan.id, null, "PLAN_ACCEPTED", { artifact, checks: receipts })
      this.outcome(
        plan.id,
        { status: "accepted", artifact, evidence: receipts, taskIDs: input.integrationOrder },
        true,
      )
    })
  }
  private async cleanupWorktrees(plan: PlanRow, fence: number) {
    const owned = [
      ...new Set(
        this.store
          .effects(plan.id)
          .filter(
            (effect) =>
              ["worktree", "graph-worktree"].includes(effect.kind) && effect.state === "completed",
          )
          .map((effect) => JSON.parse(effect.receipt!).workspace as string),
      ),
    ]
    for (const workspace of owned) {
      if (workspace === this.directory) throw new Error("Refusing to remove the shared checkout")
      const effect =
        this.store
          .effects(plan.id)
          .find(
            (entry) =>
              entry.kind === "worktree-remove" && JSON.parse(entry.payload).workspace === workspace,
          ) ?? this.effect(plan.id, null, null, "worktree-remove", { workspace }, fence)
      if (effect.state === "completed") continue
      try {
        const active = await Promise.all(
          this.store
            .attempts(plan.id)
            .filter((attempt) => attempt.workspace === workspace)
            .map((attempt) => this.host.session(attempt.session_id)),
        )
        if (active.some((session) => session?.busy)) throw new Error("Worker is still active")
        const listed = await this.host.worktrees()
        if (listed.includes(workspace)) await this.host.removeWorktree(workspace)
        else if (existsSync(workspace))
          throw new Error(
            "Owned directory is not registered with OpenCode; preserve it for reconciliation",
          )
        this.receipt(effect, { workspace, removed: true, native: true }, fence)
      } catch (error) {
        const reason = errorText(error)
        this.store.fenced(this.owner, fence, (db) => {
          db.query("UPDATE runner_effects SET state='uncertain',receipt=? WHERE id=?").run(
            JSON.stringify({ error: reason }),
            effect.id,
          )
          db.query(
            "UPDATE runner_plans SET state='cleanup-blocked',reason=?,version=version+1 WHERE id=?",
          ).run(reason, plan.id)
          this.store.record(plan.id, null, "CLEANUP_BLOCKED", { workspace, reason })
        })
        this.outcome(
          plan.id,
          {
            status: "cleanup-blocked",
            reason,
            artifact: plan.artifact,
            allowedActions: ["integrated"],
          },
          true,
        )
        return
      }
    }
    this.store.fenced(this.owner, fence, (db) => {
      db.query(
        "UPDATE runner_plans SET state='integrated',reason=NULL,version=version+1 WHERE id=?",
      ).run(plan.id)
      this.store.record(plan.id, null, "WORKTREES_RECONCILED", {
        directories: owned,
        artifact: plan.artifact,
      })
    })
    this.outcome(
      plan.id,
      { status: "integrated", artifact: plan.artifact, worktreesRemoved: owned },
      false,
    )
  }
  private async reconcileEffect(effect: EffectRow, fence: number) {
    const payload = JSON.parse(effect.payload)
    try {
      if (effect.kind === "session") {
        const session = await this.host.session(payload.sessionID)
        if (session) {
          this.receipt(effect, { sessionID: session.id, reconciled: true }, fence)
          return
        }
      } else if (effect.kind === "prompt") {
        const session = await this.host.session(payload.sessionID)
        if (session?.messages.some((m) => m.id === payload.messageID)) {
          this.receipt(
            effect,
            {
              messageID: payload.messageID,
              reconciled: true,
            },
            fence,
          )
          return
        }
        // This guard throws before ctx.session.prompt. A queued native move may
        // finish after the call returns; no model work was admitted by this effect.
        if (
          !session?.messages.some((m) => m.id === payload.messageID) &&
          JSON.parse(effect.receipt ?? "{}").error ===
            "Worker session is not in its assigned worktree"
        ) {
          this.store.fenced(this.owner, fence, (db) => {
            db.query("UPDATE runner_effects SET state='failed',receipt=? WHERE id=?").run(
              JSON.stringify({
                notSent: true,
                reason: "Native move queued; prompt guard prevented dispatch",
              }),
              effect.id,
            )
            db.query("UPDATE runner_attempts SET message_id=? WHERE id=?").run(
              messageID(),
              effect.attempt_id!,
            )
            this.store.record(effect.plan_id, effect.task_id, "PROMPT_NOT_DISPATCHED", {
              effectID: effect.id,
              continuation: "new durable message after native move wait",
            })
          })
          return
        }
      } else if (effect.kind === "worktree" || effect.kind === "graph-worktree") {
        const candidates = (await this.host.worktrees())
          .filter(
            (directory) =>
              directory === payload.workspace ||
              (/^-[2-9]$|^-10$/.test(directory.slice(payload.workspace.length)) &&
                directory.startsWith(payload.workspace)),
          )
          .filter(
            (directory) =>
              existsSync(directory) && git(directory, ["rev-parse", "HEAD"]) === payload.base,
          )
        if (candidates.length === 1) {
          const workspace = candidates[0]!
          if (effect.attempt_id)
            this.store.fenced(this.owner, fence, (db) =>
              db
                .query("UPDATE runner_attempts SET workspace=? WHERE id=?")
                .run(workspace, effect.attempt_id!),
            )
          this.receipt(effect, { workspace, base: payload.base, reconciled: true }, fence)
          return
        }
      } else if (effect.kind.startsWith("verify:") || effect.kind.startsWith("graph-verify:")) {
        if (existsSync(payload.receiptPath)) {
          const check = JSON.parse(readFileSync(payload.receiptPath, "utf8")) as CheckReceipt
          if (
            check.artifact === payload.artifact &&
            check.command === payload.check.command &&
            check.inputIdentity === payload.identity &&
            artifactUnchanged(payload.workspace, payload.artifact)
          ) {
            this.receipt(effect, { check, reconciled: true }, fence)
            return
          }
        }
      }
      if (effect.state !== "uncertain")
        this.uncertain(
          effect,
          "No conclusive host/artifact receipt; effect was not repeated",
          fence,
        )
    } catch (error) {
      if (effect.state !== "uncertain") this.uncertain(effect, error, fence)
    }
  }
  private async deliver(fence: number) {
    type Message = {
      id: string
      plan_id: string
      session_id: string
      message_id: string
      payload: string
      state: string
      resume: number
    }
    const messages = this.store.atomic((db) =>
      db
        .query<Message, [string]>(
          "SELECT o.* FROM runner_outbox o JOIN runner_plans p ON p.id=o.plan_id WHERE p.project_directory=? AND o.state!='delivered' ORDER BY o.rowid LIMIT 20",
        )
        .all(this.directory),
    )
    for (const message of messages) {
      const session = await this.host.session(message.session_id)
      if (!session || session.archived) continue
      if (message.state !== "pending") {
        if (session.messages.some((m) => m.id === message.message_id))
          this.store.fenced(this.owner, fence, (db) => {
            db.query("UPDATE runner_outbox SET state='delivered' WHERE id=?").run(message.id)
            this.store.repository.changed()
          })
        continue
      }
      this.store.fenced(this.owner, fence, (db) =>
        db.query("UPDATE runner_outbox SET state='sending' WHERE id=?").run(message.id),
      )
      try {
        await this.host.notify({
          sessionID: message.session_id,
          id: message.message_id,
          text: `LAZERS outcome\n${message.payload}`,
          resume: Boolean(message.resume),
        })
        this.store.fenced(this.owner, fence, (db) => {
          db.query("UPDATE runner_outbox SET state='delivered' WHERE id=?").run(message.id)
          this.store.repository.changed()
        })
      } catch (error) {
        this.store.fenced(this.owner, fence, (db) => {
          db.query("UPDATE runner_outbox SET state='uncertain' WHERE id=?").run(message.id)
          this.store.record(message.plan_id, null, "DELIVERY_UNCERTAIN", {
            id: message.id,
            error: errorText(error),
          })
        })
      }
    }
  }
}
