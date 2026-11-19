import { sameProject } from "../project-key.ts"
import { privacyStats, safeText } from "../trajectory/privacy.ts"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fingerprint } from "../identity.ts"
import { FINGERPRINT_V2_PREFIX } from "./identity-store.ts"
import { effectiveVerificationCheck, verificationReceiptDeadline } from "./verification-timeout.ts"
import type { VerificationTimeoutTarget } from "./verification-timeout.ts"
import type { TaskProposal } from "../task.ts"
import {
  artifactExists,
  checkResourcesSettled,
  gitAsync,
  registeredWorktreePaths,
} from "./artifacts.ts"
import type { CheckReceipt } from "./artifacts.ts"
import { checkSucceeded, checkFailureReason } from "./checks.ts"
import { samePhysicalWorkspace } from "./workspace-location.ts"
import { startupWorktreeCandidates } from "./startup-recovery.ts"
import {
  activateRetainedVerificationResources,
  beginRetainedVerificationCheck,
  completeRetainedVerificationCheck,
  markRetainedVerificationCheckUncertain,
  registerRetainedVerificationResources,
  retainedVerification,
  retainedVerificationChecks,
  retainedVerificationsForProject,
  saveRetainedVerification,
  setRetainedVerificationCheckCleanup,
  setRetainedVerificationWorkspace,
  settleRetainedVerificationResources,
  updateRetainedVerificationResourceIdentity,
} from "./retained-verification/store.ts"
import { forgetVerificationActivity, verificationActivityKey } from "./verification-activities.ts"
import type { RetainedVerification } from "./retained-verification/schema.ts"
import {
  createRetainedCheckContext,
  observeRetainedCheckContext,
  observeRetainedCheckIsolationWitness,
  removeRetainedCheckContext,
  removeRetainedCheckContextFromWitness,
  removeRetainedCheckSetupResources,
  retainedCheckIsolationWitness,
  retainedTemporaryDirectoryAliasPath,
  RetainedSetupProcessTreeUncertainError,
} from "./retained-verification/isolation.ts"
import type {
  RetainedCheckSetupLink,
  RetainedCheckSetupResource,
} from "./retained-verification/isolation.ts"
import { ProbeRepository } from "../verification/probe/store.ts"
import { ResourceRepository } from "../verification/resources/store.ts"
import { retainedVerificationProbeBasis } from "./retained-verification/probe.ts"
import {
  retainedProcedurePlan,
  retainedProjectIdentity,
} from "./retained-verification/procedure.ts"

import type { TaskRuntime } from "./runtime.ts"
import { errorText } from "./runtime-helpers.ts"
import { isRecord } from "./runtime-helpers.ts"
import { sameVerificationCheckIdentity } from "./runtime-helpers.ts"
import { WORKTREE_CLEANUP_FALLBACK_MS } from "./runtime-helpers.ts"
import { pathEntryExists } from "./runtime-helpers.ts"

function isCurrentRetainedVerification(
  current: RetainedVerification | undefined,
): current is RetainedVerification {
  return current !== undefined && ["pending", "task-checks"].includes(current.state)
}

type RetainedCheckRow = ReturnType<typeof retainedVerificationChecks>[number]
type RetainedCheckContext = Awaited<ReturnType<typeof createRetainedCheckContext>>

/** What every step of one retained check shares. */
type RetainedCheckRun = {
  initial: RetainedVerification
  phase: "task"
  check: TaskProposal["verification"][number]
  workspace: string
  artifact: string
  fence: number
  parentSignal: AbortSignal | undefined
  effectiveCheck: TaskProposal["verification"][number]
  deadline: ReturnType<TaskRuntime["verificationDeadline"]>
  procedurePlan: Extract<ReturnType<typeof retainedProcedurePlan>, { status: "supported" }>["plan"]
  activityID: string
}

/** The receipt a previous run saved in the record or on disk; unreadable counts as absent. */
function readSavedRetainedReceipt(existing: RetainedCheckRow): unknown {
  try {
    if (existing.receipt) return JSON.parse(existing.receipt) as unknown
    if (existsSync(existing.receiptPath))
      return JSON.parse(readFileSync(existing.receiptPath, "utf8")) as unknown
  } catch {
    return undefined
  }
  return undefined
}

type WorktreeInventory = { native: string[]; gitWorktrees: string[] }

function isTerminalRetainedState(state: string) {
  return ["accepted", "failed", "cancelled"].includes(state)
}

export class RetainedVerificationExecution {
  constructor(
    private readonly runtime: {
      checkActivity: TaskRuntime["checkActivity"]
      dataDirectory: TaskRuntime["dataDirectory"]
      directory: TaskRuntime["directory"]
      host: TaskRuntime["host"]
      now: TaskRuntime["now"]
      observeRetainedRepairCandidate: TaskRuntime["observeRetainedRepairCandidate"]
      outcome: TaskRuntime["outcome"]
      owner: TaskRuntime["owner"]
      projectID: TaskRuntime["projectID"]
      beforeRetainedCheckBegin: TaskRuntime["beforeRetainedCheckBegin"]
      recoverCancelledRetainedChecks: TaskRuntime["recoverCancelledRetainedChecks"]
      retainedDependencyInstaller: TaskRuntime["retainedDependencyInstaller"]
      retainedRepairCandidateCurrent: TaskRuntime["retainedRepairCandidateCurrent"]
      retainedVerificationAborts: TaskRuntime["retainedVerificationAborts"]
      retainedVerificationWorkspacePath: TaskRuntime["retainedVerificationWorkspacePath"]
      runVerificationCheck: TaskRuntime["runVerificationCheck"]
      startCheckActivity: TaskRuntime["startCheckActivity"]
      store: TaskRuntime["store"]
      terminalRetainedVerificationCleanupChecks: TaskRuntime["terminalRetainedVerificationCleanupChecks"]
      validArchitect: TaskRuntime["validArchitect"]
      verificationDeadline: TaskRuntime["verificationDeadline"]
      verificationTarget: TaskRuntime["verificationTarget"]
    },
  ) {}

  /**
   * The call is live while it is unfinished, its plan is stopped or accepted at
   * the same revision, and the task, latest attempt and original checkout are
   * the ones it was started for. The plan version is not part of that: other
   * work on the plan moves the version without changing the candidate.
   */
  retainedVerificationLive(operationID: string): boolean {
    try {
      const current = this.runtime.store.atomic((db) => retainedVerification(db, operationID))
      if (!current || !["pending", "task-checks"].includes(current.state)) return false
      const plan = this.runtime.store.plan(current.planID)
      const task = this.runtime.store.repository.get(current.taskID)
      const latestAttempt = this.runtime.store
        .attempts(current.planID)
        .filter((attempt) => attempt.task_id === current.taskID)
        .at(-1)
      return Boolean(
        plan &&
        ["blocked", "accepted", "cleanup-blocked"].includes(plan.state) &&
        plan.revision === current.planRevision &&
        task &&
        task.revision === current.taskRevision &&
        sameProject(task.provenance.projectID, this.runtime.projectID) &&
        task.provenance.projectDirectory === this.runtime.directory &&
        !this.runtime.store.repository.taskDisposition(current.taskID) &&
        latestAttempt?.id === current.attemptID &&
        latestAttempt.session_id === current.originalSessionID &&
        latestAttempt.message_id === current.originalMessageID &&
        (!current.repair ||
          (this.runtime.retainedRepairCandidateCurrent(plan, latestAttempt, current.repair) &&
            (latestAttempt.artifact === current.repair.previousArtifact ||
              latestAttempt.artifact === current.artifact))) &&
        realpathSync(latestAttempt.workspace) === current.originalWorkspace,
      )
    } catch {
      return false
    }
  }

  private async retainedWorkspaceUnchanged(
    workspace: string,
    artifact: string,
    ownedDependencyLink?: { path: string; target: string } | null,
  ): Promise<boolean> {
    try {
      const workspaceRoot = realpathSync(workspace)
      let status = await gitAsync(workspace, ["status", "--porcelain", "--untracked-files=all"])
      if (ownedDependencyLink) {
        if (
          ownedDependencyLink.path !== join(workspaceRoot, "node_modules") ||
          !lstatSync(ownedDependencyLink.path).isSymbolicLink() ||
          realpathSync(ownedDependencyLink.path) !== ownedDependencyLink.target
        )
          return false
        status = status
          .split("\n")
          .filter((line) => line !== "?? node_modules")
          .join("\n")
      }
      return (
        realpathSync(await gitAsync(workspace, ["rev-parse", "--show-toplevel"])) ===
          workspaceRoot &&
        (await gitAsync(workspace, ["rev-parse", "HEAD"])) === artifact &&
        !status &&
        !(await gitAsync(workspace, ["ls-files", "-u", "-z"]))
      )
    } catch {
      return false
    }
  }

  private retainedProbeResourcesAreIsolated(
    operation: RetainedVerification,
    workspace: string,
    resources: ReturnType<ResourceRepository["resourcesForRun"]>,
  ): boolean {
    if (resources.length === 0) return false
    const canonicalPath = (value: string) => {
      const absolute = resolve(value)
      try {
        return (existsSync(absolute) ? realpathSync(absolute) : absolute).toLocaleLowerCase()
      } catch {
        return absolute.toLocaleLowerCase()
      }
    }
    const workspaces = [
      operation.originalWorkspace,
      workspace,
      this.runtime.store.repository.path,
      process.env.HOME,
      process.env.XDG_CONFIG_HOME,
      process.env.XDG_DATA_HOME,
      process.env.XDG_CACHE_HOME,
      process.env.XDG_STATE_HOME,
      process.env.LAZERS_VERIFICATION_SQLITE,
    ]
      .filter((path): path is string => Boolean(path))
      .map(canonicalPath)
    const overlaps = (left: string, right: string) => {
      const path = canonicalPath(left)
      const parent = canonicalPath(right)
      const rel = relative(parent, path)
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
    }
    const currentRunID = resources[0]!.runID
    if (resources.some((resource) => resource.runID !== currentRunID)) return false
    const priorOwnedResources = this.runtime.store.atomic((db) => {
      const table = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='owned_resources'",
        )
        .get()
      if (!table) return []
      return db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM owned_resources WHERE project_directory=?",
        )
        .all(operation.projectDirectory)
        .flatMap(({ payload }) => {
          try {
            const resource = JSON.parse(payload) as {
              runID?: unknown
              resourceKey?: unknown
              state?: unknown
            }
            if (resource.runID === currentRunID || resource.state === "removed") return []
            if (
              typeof resource.resourceKey !== "string" ||
              !resource.resourceKey.startsWith("filesystem:")
            )
              return [null]
            const path = resource.resourceKey.slice("filesystem:".length)
            return path.startsWith("/") ? [path] : [null]
          } catch {
            return [null]
          }
        })
    })
    if (priorOwnedResources.some((path) => path === null)) return false
    const retainedCheckPaths = this.runtime.store.atomic((db) =>
      db
        .query<{ canonical_path: string }, [string, string]>(
          `SELECT canonical_path FROM runner_retained_verification_resources
           WHERE project_directory=? AND operation_id=?`,
        )
        .all(operation.projectDirectory, operation.id)
        .map((row) => row.canonical_path),
    )
    const currentPaths = resources.map((resource) => {
      if (!resource.resourceKey.startsWith("filesystem:")) return false
      const resourcePath = resource.resourceKey.slice("filesystem:".length)
      if (!resourcePath.startsWith("/")) return false
      return canonicalPath(resourcePath)
    })
    if (currentPaths.some((path) => path === false)) return false
    const allCurrentPaths = currentPaths as string[]
    const distinct = allCurrentPaths.every((path, index) =>
      allCurrentPaths
        .slice(index + 1)
        .every((other) => !overlaps(path, other) && !overlaps(other, path)),
    )
    const externalPaths = [...priorOwnedResources, ...retainedCheckPaths].filter(
      (path): path is string => path !== null,
    )
    return (
      distinct &&
      allCurrentPaths.every((path) =>
        [...workspaces, ...externalPaths].every(
          (blocked) => !overlaps(path, blocked) && !overlaps(blocked, path),
        ),
      )
    )
  }

  retainedVerificationIsolatedWorkspace(
    operation: RetainedVerification,
    phase: "task" | "combined",
  ): string | undefined {
    return phase === "task"
      ? (operation.taskWorkspace ?? undefined)
      : (operation.combinedWorkspace ?? undefined)
  }

  /**
   * The call failed: record the reason and tell the Architect, who runs
   * verify-retained again once the cause is addressed. Nothing waits on it.
   */
  async failRetainedVerification(
    initial: RetainedVerification,
    reason: string,
    fence: number,
  ): Promise<void> {
    this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = retainedVerification(db, initial.id)
      if (!isCurrentRetainedVerification(current)) return
      const updated: RetainedVerification = {
        ...current,
        state: "failed",
        failureReason: reason,
        updatedAt: this.runtime.now(),
      }
      saveRetainedVerification(db, updated)
      this.runtime.store.record(current.planID, current.taskID, "RETAINED_VERIFICATION_FAILED", {
        operationID: current.id,
        reason,
        originalAttemptPreserved: true,
      })
      const plan = this.runtime.store.plan(current.planID)
      if (!plan || ["cancelling", "cancelled", "integrated"].includes(plan.state)) return
      this.runtime.outcome(
        plan.id,
        {
          status: "retained-verification-failed",
          operationID: current.id,
          taskID: current.taskID,
          attemptID: current.attemptID,
          artifact: current.artifact,
          reason: safeText(reason, privacyStats()),
        },
        true,
      )
    })
  }

  private async setRetainedVerificationState(
    initial: RetainedVerification,
    state: RetainedVerification["state"],
    reason: string | null,
    fence: number,
  ): Promise<RetainedVerification | undefined> {
    return this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = retainedVerification(db, initial.id)
      if (!isCurrentRetainedVerification(current)) return undefined
      if (current.state === state && current.failureReason === reason) return current
      const updated: RetainedVerification = {
        ...current,
        state,
        failureReason: reason,
        updatedAt: this.runtime.now(),
      }
      saveRetainedVerification(db, updated)
      return updated
    })
  }

  private async ensureRetainedVerificationWorkspace(
    initial: RetainedVerification,
    phase: "task",
    artifact: string,
    fence: number,
  ): Promise<string | undefined> {
    if (!this.retainedVerificationLive(initial.id)) return undefined
    const field = initial.taskWorkspace
    const fieldState = initial.taskWorkspaceState
    const proposed = this.runtime.retainedVerificationWorkspacePath(initial.id, phase)
    const workspace = field ?? proposed
    const native = await this.runtime.host.worktrees()
    const candidates =
      fieldState === "reserved" || fieldState === "uncertain"
        ? startupWorktreeCandidates(workspace)
        : [workspace]
    const present = native.find((item) =>
      candidates.some((candidate) => samePhysicalWorkspace(item, candidate)),
    )
    if (present) {
      let mismatches: string[]
      try {
        const actual = realpathSync(present)
        const topLevel = realpathSync(await gitAsync(actual, ["rev-parse", "--show-toplevel"]))
        const head = await gitAsync(actual, ["rev-parse", "HEAD"])
        const status = await gitAsync(actual, ["status", "--porcelain", "--untracked-files=all"])
        const conflicts = await gitAsync(actual, ["ls-files", "-u", "-z"])
        const pendingCheck = this.runtime.store.atomic((db) =>
          retainedVerificationChecks(db, initial.id, phase).find(
            (check) => check.workspace === actual && check.artifact === artifact,
          ),
        )
        const pendingActivity = pendingCheck
          ? this.runtime.checkActivity(`retained:${initial.id}:${phase}:${pendingCheck.checkID}`, {
              operationID: initial.id,
              phase,
              checkID: pendingCheck.checkID,
              inputFingerprint: pendingCheck.inputFingerprint,
              workspace: pendingCheck.workspace,
              artifact: pendingCheck.artifact,
              contextPath: pendingCheck.contextPath,
            })
          : undefined
        const checkOwnsCheckoutChanges = Boolean(
          pendingCheck &&
          (pendingActivity || pendingCheck.receipt || existsSync(pendingCheck.receiptPath)),
        )
        mismatches = [
          ...(actual !== realpathSync(present) ? ["noncanonical-path"] : []),
          ...(realpathSync(dirname(actual)) !== realpathSync(dirname(workspace))
            ? ["unexpected-parent"]
            : []),
          ...(samePhysicalWorkspace(actual, initial.originalWorkspace)
            ? ["original-workspace"]
            : []),
          ...(samePhysicalWorkspace(actual, this.runtime.directory) ? ["project-workspace"] : []),
          ...(topLevel !== actual ? ["repository-root"] : []),
          ...(head !== artifact ? ["candidate-identity"] : []),
          ...(status && !checkOwnsCheckoutChanges ? ["dirty-checkout"] : []),
          ...(conflicts ? ["unmerged-files"] : []),
        ]
        if (mismatches.length === 0) {
          const updated = this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
            const current = retainedVerification(db, initial.id)
            if (!isCurrentRetainedVerification(current)) return undefined
            const saved = setRetainedVerificationWorkspace(db, current, "task", actual, "owned")
            this.runtime.store.record(
              current.planID,
              current.taskID,
              "RETAINED_VERIFICATION_WORKSPACE_OWNED",
              {
                operationID: current.id,
                phase,
                workspace: actual,
                artifact,
                recovered: fieldState === "reserved" || fieldState === "uncertain",
              },
            )
            return saved
          })
          return updated ? actual : undefined
        }
      } catch (error) {
        await this.failRetainedVerification(
          initial,
          `Retained ${phase} verification checkout ownership or candidate is uncertain: ${errorText(error)}`,
          fence,
        )
        return undefined
      }
      await this.failRetainedVerification(
        initial,
        `Retained ${phase} verification checkout exists but its canonical owner or candidate identity is not proven${mismatches.length ? ` (${mismatches.join(", ")})` : ""}`,
        fence,
      )
      return undefined
    }
    const unregisteredPath = candidates.find((candidate) => existsSync(candidate))
    if (unregisteredPath) {
      await this.failRetainedVerification(
        initial,
        `Retained ${phase} verification checkout path exists without native worktree ownership; preserve ${unregisteredPath}`,
        fence,
      )
      return undefined
    }
    if (fieldState !== null) {
      await this.failRetainedVerification(
        initial,
        `Retained ${phase} verification checkout creation outcome is uncertain; it will not be replayed`,
        fence,
      )
      return undefined
    }
    const reserved = this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = retainedVerification(db, initial.id)
      if (!isCurrentRetainedVerification(current)) return undefined
      const saved = setRetainedVerificationWorkspace(db, current, "task", workspace, "reserved")
      this.runtime.store.record(
        current.planID,
        current.taskID,
        "RETAINED_VERIFICATION_WORKSPACE_RESERVED",
        {
          operationID: current.id,
          phase,
          workspace,
          artifact,
        },
      )
      return saved
    })
    if (!reserved || !this.retainedVerificationLive(initial.id)) return undefined
    let returnedWorkspace: string | undefined
    try {
      mkdirSync(dirname(workspace), { recursive: true, mode: 0o700 })
      returnedWorkspace = await this.runtime.host.worktree({ directory: workspace, base: artifact })
      const actual = realpathSync(returnedWorkspace)
      const canonical = realpathSync(actual)
      const currentNative = await this.runtime.host.worktrees()
      if (
        !currentNative.some((item) => samePhysicalWorkspace(item, canonical)) ||
        realpathSync(dirname(canonical)) !== realpathSync(dirname(workspace)) ||
        samePhysicalWorkspace(canonical, initial.originalWorkspace) ||
        samePhysicalWorkspace(canonical, this.runtime.directory) ||
        realpathSync(await gitAsync(canonical, ["rev-parse", "--show-toplevel"])) !== canonical ||
        (await gitAsync(canonical, ["rev-parse", "HEAD"])) !== artifact ||
        (await gitAsync(canonical, ["status", "--porcelain", "--untracked-files=all"])) ||
        (await gitAsync(canonical, ["ls-files", "-u", "-z"]))
      )
        throw new Error(
          "Native worktree is not a distinct clean canonical checkout of the exact candidate",
        )
      if (!this.retainedVerificationLive(initial.id)) {
        await this.failRetainedVerification(
          initial,
          "Retained verification authority changed during checkout creation",
          fence,
        )
        return undefined
      }
      this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
        const current = retainedVerification(db, initial.id)
        if (!isCurrentRetainedVerification(current)) return
        setRetainedVerificationWorkspace(db, current, "task", canonical, "owned")
        this.runtime.store.record(
          current.planID,
          current.taskID,
          "RETAINED_VERIFICATION_WORKSPACE_OWNED",
          {
            operationID: current.id,
            phase,
            workspace: canonical,
            artifact,
            recovered: false,
          },
        )
      })
      return this.retainedVerificationLive(initial.id) ? canonical : undefined
    } catch (error) {
      this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
        const current = retainedVerification(db, initial.id)
        if (!current) return
        setRetainedVerificationWorkspace(
          db,
          current,
          "task",
          returnedWorkspace ?? workspace,
          "uncertain",
        )
      })
      await this.failRetainedVerification(
        initial,
        `Retained ${phase} verification checkout creation is uncertain: ${errorText(error)}`,
        fence,
      )
      return undefined
    }
  }

  retainedVerificationCheckReceipt(
    raw: unknown,
    operation: RetainedVerification,
    phase: "task" | "combined",
    check: TaskProposal["verification"][number],
    workspace: string,
    artifact: string,
    _environmentIdentity: string,
  ): CheckReceipt | undefined {
    if (!isRecord(raw) || !isRecord(raw.isolation)) return undefined
    const receipt = raw as unknown as CheckReceipt
    const witness = raw.isolation
    if (
      receipt.id !== check.id ||
      receipt.command !== check.command ||
      receipt.cwd !== workspace ||
      receipt.artifact !== artifact ||
      receipt.inputIdentity !== artifact ||
      witness.schemaVersion !== 1 ||
      witness.operationID !== operation.id ||
      witness.phase !== phase ||
      witness.checkID !== check.id ||
      witness.originalWorkspace !== operation.originalWorkspace ||
      witness.candidateWorkspace !== workspace ||
      witness.taskDatabase !== realpathSync(this.runtime.store.repository.path)
    )
      return undefined
    return receipt
  }

  completeRetainedCheck(
    operation: RetainedVerification,
    phase: "task" | "combined",
    checkID: string,
    receipt: CheckReceipt,
  ): boolean {
    return this.runtime.store.atomic((db) => {
      if (!completeRetainedVerificationCheck(db, operation.id, phase, checkID, receipt))
        return false
      // Persist the result and event together. Receipt recovery, normal ticks,
      // stop and cancellation may all observe the same final subprocess result.
      this.runtime.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_CHECK_COMPLETED",
        {
          operationID: operation.id,
          phase,
          checkID,
          artifact: receipt.artifact,
          workspace: receipt.cwd,
          environmentIdentity: receipt.environmentIdentity,
          exitCode: receipt.exitCode,
          timedOut: receipt.timedOut,
          passed: checkSucceeded(receipt),
          processCleanup: receipt.processCleanup,
          cancelled: operation.state === "cancelled",
        },
      )
      return true
    })
  }

  private async runRetainedVerificationChecks(
    initial: RetainedVerification,
    phase: "task",
    checks: TaskProposal["verification"],
    workspace: string,
    artifact: string,
    fence: number,
    parentSignal?: AbortSignal,
  ): Promise<CheckReceipt[] | undefined> {
    const results: CheckReceipt[] = []
    for (const check of checks) {
      const receipt = await this.runRetainedVerificationCheck(
        initial,
        phase,
        check,
        workspace,
        artifact,
        fence,
        parentSignal,
      )
      if (!receipt) return undefined
      results.push(receipt)
    }
    return results
  }

  /**
   * One check: its settled receipt when an earlier run already produced it, or undefined when the
   * operation must stop here (failed, cancelled, or the check was just started and will report later).
   */
  private async runRetainedVerificationCheck(
    initial: RetainedVerification,
    phase: "task",
    check: TaskProposal["verification"][number],
    workspace: string,
    artifact: string,
    fence: number,
    parentSignal: AbortSignal | undefined,
  ): Promise<CheckReceipt | undefined> {
    if (parentSignal?.aborted || !this.retainedVerificationLive(initial.id)) return undefined
    const plan = this.runtime.store.plan(initial.planID)
    if (!plan || plan.revision !== initial.planRevision)
      throw new Error("Retained verification plan revision changed")
    const target: VerificationTimeoutTarget = this.runtime.verificationTarget(
      plan,
      phase,
      check,
      artifact,
      initial.taskID,
      initial.taskRevision,
      initial.attemptID,
    )
    const deadline = this.runtime.verificationDeadline(target)
    const effectiveCheck = effectiveVerificationCheck(check, deadline)
    const procedure = retainedProcedurePlan(check.command)
    if (procedure.status !== "supported") {
      await this.failRetainedVerification(
        initial,
        `Verification ${check.id} ${procedure.reason}; required resources are not bound to the retained context`,
        fence,
      )
      return undefined
    }
    const run: RetainedCheckRun = {
      initial,
      phase,
      check,
      workspace,
      artifact,
      fence,
      parentSignal,
      effectiveCheck,
      deadline,
      procedurePlan: procedure.plan,
      activityID: `retained:${initial.id}:${phase}:${check.id}`,
    }
    const existing = this.runtime.store.atomic((db) =>
      retainedVerificationChecks(db, initial.id, phase).find((row) => row.checkID === check.id),
    )
    if (existing) return this.settleExistingRetainedCheck(run, existing)

    if (await this.reconcileInterruptedRetainedCheckSetup(initial, phase, check, workspace, fence))
      return undefined
    await this.startRetainedCheck(run)
    return undefined
  }

  private forgetRetainedCheckActivity(run: RetainedCheckRun, activityIdentity: unknown) {
    forgetVerificationActivity(
      verificationActivityKey(this.runtime.store.repository.path, run.activityID),
      fingerprint(activityIdentity),
    )
  }

  /** A check that finished with live subprocess resources cannot be trusted: stop the operation. */
  private async failUnsettledRetainedCheck(run: RetainedCheckRun, receipt: CheckReceipt) {
    const { initial, phase, check } = run
    this.runtime.store.atomic((db) =>
      settleRetainedVerificationResources(
        db,
        initial.id,
        phase,
        check.id,
        "uncertain",
        this.runtime.now(),
      ),
    )
    await this.failRetainedVerification(
      initial,
      `Retained verification ${phase}:${check.id} completed with exit ${receipt.exitCode ?? "unknown"} and timedOut=${receipt.timedOut}, but subprocess cleanup is uncertain: ${receipt.processCleanup?.detail ?? "termination was not confirmed"}`,
      run.fence,
    )
  }

  /** Decides a check that already has a durable record: reuse its receipt, recover it, or stop. */
  private async settleExistingRetainedCheck(
    run: RetainedCheckRun,
    existing: RetainedCheckRow,
  ): Promise<CheckReceipt | undefined> {
    const { initial, phase, check, workspace, artifact, effectiveCheck } = run
    const activityIdentity = {
      operationID: initial.id,
      phase,
      checkID: check.id,
      inputFingerprint: existing.inputFingerprint,
      workspace: existing.workspace,
      artifact: existing.artifact,
      contextPath: existing.contextPath,
    }
    const savedReceipt = readSavedRetainedReceipt(existing)
    if (
      existing.artifact !== artifact ||
      existing.workspace !== workspace ||
      !sameVerificationCheckIdentity(JSON.parse(existing.checkJSON), effectiveCheck)
    ) {
      await this.failRetainedVerification(
        initial,
        `Retained check ${phase}:${check.id} no longer matches its recorded command or workspace`,
        run.fence,
      )
      return undefined
    }
    if (existing.state === "completed" && existing.receipt)
      return this.reuseCompletedRetainedCheck(run, existing, activityIdentity)
    if (existing.state === "intended" && existsSync(existing.receiptPath)) {
      const recovered = await this.recoverIntendedRetainedCheck(run, existing, savedReceipt)
      if (recovered)
        return this.adoptRecoveredRetainedCheck(run, existing, recovered, activityIdentity)
    }
    return this.haltUnresolvedRetainedCheck(run, activityIdentity)
  }

  private async reuseCompletedRetainedCheck(
    run: RetainedCheckRun,
    existing: RetainedCheckRow,
    activityIdentity: unknown,
  ): Promise<CheckReceipt | undefined> {
    const { initial, phase, check, workspace, artifact, effectiveCheck } = run
    const receipt = this.retainedVerificationCheckReceipt(
      JSON.parse(existing.receipt!),
      initial,
      phase,
      effectiveCheck,
      workspace,
      artifact,
      existing.environmentIdentity,
    )
    if (!receipt) {
      await this.failRetainedVerification(
        initial,
        `Retained verification receipt ${phase}:${check.id} is not operation-bound`,
        run.fence,
      )
      return undefined
    }
    this.forgetRetainedCheckActivity(run, activityIdentity)
    this.runtime.retainedVerificationAborts.delete(initial.id)
    if (!checkResourcesSettled(receipt)) {
      await this.failUnsettledRetainedCheck(run, receipt)
      return undefined
    }
    if (existing.cleanupState !== "complete")
      await this.cleanupRetainedCheckResources(
        initial,
        phase,
        check.id,
        existing.contextPath,
        receipt.isolation,
        run.fence,
      )
    return receipt
  }

  /** The isolated receipt an interrupted run left on disk, when its isolation witness still verifies. */
  private async recoverIntendedRetainedCheck(
    run: RetainedCheckRun,
    existing: RetainedCheckRow,
    onDisk: unknown,
  ): Promise<CheckReceipt | undefined> {
    const { initial, phase, check, workspace, artifact, effectiveCheck } = run
    try {
      if (
        await observeRetainedCheckIsolationWitness(
          existing.contextPath,
          isRecord(onDisk) ? onDisk.isolation : undefined,
          {
            operationID: initial.id,
            phase,
            checkID: check.id,
            originalWorkspace: initial.originalWorkspace,
            candidateWorkspace: workspace,
            taskDatabase: this.runtime.store.repository.path,
            projectDirectory: this.runtime.directory,
            candidateArtifact: artifact,
            projectIdentity: retainedProjectIdentity(this.runtime.directory, workspace, artifact),
            procedurePlan: run.procedurePlan,
          },
        )
      )
        return this.retainedVerificationCheckReceipt(
          onDisk,
          initial,
          phase,
          effectiveCheck,
          workspace,
          artifact,
          existing.environmentIdentity,
        )
    } catch {
      return undefined
    }
    return undefined
  }

  private async adoptRecoveredRetainedCheck(
    run: RetainedCheckRun,
    existing: RetainedCheckRow,
    recovered: CheckReceipt,
    activityIdentity: unknown,
  ): Promise<CheckReceipt | undefined> {
    const { initial, phase, check } = run
    const saved = this.runtime.store.atomic((db) => {
      const current = retainedVerification(db, initial.id)
      if (!isCurrentRetainedVerification(current)) return false
      return this.completeRetainedCheck(current, phase, check.id, recovered)
    })
    if (!saved) return undefined
    this.forgetRetainedCheckActivity(run, activityIdentity)
    this.runtime.retainedVerificationAborts.delete(initial.id)
    if (!checkResourcesSettled(recovered)) {
      await this.failUnsettledRetainedCheck(run, recovered)
      return undefined
    }
    await this.cleanupRetainedCheckResources(
      initial,
      phase,
      check.id,
      existing.contextPath,
      recovered.isolation,
      run.fence,
    )
    return recovered
  }

  /** A recorded intent with no conclusive receipt: still running means wait, otherwise it is uncertain. */
  private async haltUnresolvedRetainedCheck(
    run: RetainedCheckRun,
    activityIdentity: unknown,
  ): Promise<undefined> {
    const { initial, phase, check } = run
    const activity = this.runtime.checkActivity(run.activityID, activityIdentity)
    if (activity?.state === "running") return undefined
    this.runtime.store.atomic((db) =>
      markRetainedVerificationCheckUncertain(
        db,
        initial.id,
        phase,
        check.id,
        "A retained check intent has no conclusive isolated receipt; it will not be replayed",
      ),
    )
    await this.failRetainedVerification(
      initial,
      activity?.state === "failed"
        ? `Retained verification check ${phase}:${check.id} is uncertain: ${errorText(activity.error)}`
        : `Retained verification check ${phase}:${check.id} is uncertain and was not replayed`,
      run.fence,
    )
    this.forgetRetainedCheckActivity(run, activityIdentity)
    return undefined
  }

  /** The canonical paths of every retained-verification resource still owned in this project. */
  private priorRetainedResourcePaths(): string[] {
    return this.runtime.store.atomic((db) => {
      const active = db
        .query<{ canonical_path: string }, [string]>(
          `SELECT canonical_path FROM runner_retained_verification_resources
             WHERE project_directory=? AND state IN ('creating','active','uncertain')`,
        )
        .all(this.runtime.directory)
      const legacy = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='owned_resources'",
        )
        .get()
      if (legacy) {
        const outstanding = db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM owned_resources WHERE project_directory=? AND json_extract(payload,'$.state') NOT IN ('removed')",
          )
          .get(this.runtime.directory)?.count
        if (outstanding)
          throw new Error(
            "An existing owned external resource has no canonical path witness; retained verification cannot prove non-overlap",
          )
      }
      return active.map((row) => row.canonical_path)
    })
  }

  /** Sets up the isolated context, records the intent, and hands the check to the activity runner. */
  private async startRetainedCheck(run: RetainedCheckRun): Promise<void> {
    const { initial, phase, check, artifact, effectiveCheck, deadline } = run
    const prior = this.priorRetainedResourcePaths()
    const controller = new AbortController()
    const runSignal = run.parentSignal
      ? AbortSignal.any([controller.signal, run.parentSignal])
      : controller.signal
    this.runtime.retainedVerificationAborts.set(initial.id, controller)
    const context = await this.setupRetainedCheckContext(run, runSignal, prior)
    if (!context) return
    const receiptPath = join(
      this.runtime.dataDirectory,
      "receipts",
      "retained-verification",
      initial.id,
      `${phase}-${check.id}.json`,
    )
    const inputFingerprint = `${FINGERPRINT_V2_PREFIX}${fingerprint({
      operationID: initial.id,
      phase,
      check: effectiveCheck,
      authoredCheck: check,
      verificationDeadline: verificationReceiptDeadline(deadline),
      workspace: run.workspace,
      artifact: this.runtime.store.treeRef(artifact),
      contextIdentity: context.identity,
      environmentIdentity: context.environmentIdentity,
    })}`
    const checkRow = await this.beginRetainedCheckRow(run, context, receiptPath, inputFingerprint)
    if (!checkRow) return
    if (!this.retainedVerificationLive(initial.id)) {
      await this.cleanupRetainedCheckResources(
        initial,
        phase,
        check.id,
        context.directory,
        retainedCheckIsolationWitness(context),
        run.fence,
      )
      this.runtime.retainedVerificationAborts.delete(initial.id)
      return
    }
    await this.dispatchRetainedCheckActivity(run, context, checkRow, runSignal, receiptPath)
  }

  private reserveRetainedSetupResource(
    run: RetainedCheckRun,
    name: string,
    realPath: string,
    device: number,
    inode: number,
  ) {
    this.runtime.store.atomic((db) =>
      registerRetainedVerificationResources(db, this.runtime.directory, {
        operationID: run.initial.id,
        phase: run.phase,
        checkID: run.check.id,
        resources: [{ name, realPath, device, inode }],
        state: "creating",
        now: this.runtime.now(),
      }),
    )
  }

  private confirmRetainedSetupResource(
    run: RetainedCheckRun,
    resourceName: string,
    resource: { realPath: string; device: number; inode: number },
    changedMessage: string,
  ) {
    const updated = this.runtime.store.atomic((db) =>
      updateRetainedVerificationResourceIdentity(db, {
        operationID: run.initial.id,
        phase: run.phase,
        checkID: run.check.id,
        resourceName,
        realPath: resource.realPath,
        device: resource.device,
        inode: resource.inode,
        now: this.runtime.now(),
      }),
    )
    if (!updated) throw new Error(changedMessage)
  }

  /** The isolated check context, or undefined once a setup failure has been cleaned up and reported. */
  private async setupRetainedCheckContext(
    run: RetainedCheckRun,
    runSignal: AbortSignal,
    priorResourcePaths: string[],
  ): Promise<RetainedCheckContext | undefined> {
    const { initial, phase, check, workspace, artifact } = run
    const rootDirectory = join(this.runtime.dataDirectory, "retained-verification-resources")
    const setup: {
      resource?: RetainedCheckSetupResource
      dependencyLink?: RetainedCheckSetupLink
      temporaryDirectoryLink?: RetainedCheckSetupLink
    } = {}
    try {
      mkdirSync(rootDirectory, { recursive: true, mode: 0o700 })
      const context = await createRetainedCheckContext({
        rootDirectory,
        operationID: initial.id,
        phase,
        checkID: check.id,
        originalWorkspace: initial.originalWorkspace,
        candidateWorkspace: workspace,
        taskDatabase: this.runtime.store.repository.path,
        projectDirectory: this.runtime.directory,
        candidateArtifact: artifact,
        priorResourcePaths,
        procedurePlan: run.procedurePlan,
        signal: runSignal,
        dependencyInstaller: this.runtime.retainedDependencyInstaller,
        onSetupPathReserved: (path) => {
          setup.resource = { path, realPath: path, device: -1, inode: -1 }
          this.reserveRetainedSetupResource(run, "setup-root", path, -1, -1)
        },
        onSetupPathCreated: (resource) => {
          setup.resource = resource
          this.confirmRetainedSetupResource(
            run,
            "setup-root",
            resource,
            "Retained verification setup-root ownership reservation changed",
          )
        },
        onResourcesCreated: (resources) =>
          this.runtime.store.atomic((db) =>
            registerRetainedVerificationResources(db, this.runtime.directory, {
              operationID: initial.id,
              phase,
              checkID: check.id,
              resources,
              state: "creating",
              now: this.runtime.now(),
            }),
          ),
        onDependencyLinkReserved: (link) => {
          setup.dependencyLink = link
          this.reserveRetainedSetupResource(run, "dependency-link", link.path, -1, -1)
        },
        onDependencyLink: (link) => {
          setup.dependencyLink = link
          this.confirmRetainedSetupResource(
            run,
            "dependency-link",
            { ...link, realPath: link.path },
            "Retained verification dependency-link ownership reservation changed",
          )
        },
        onTemporaryDirectoryLinkReserved: (link) => {
          setup.temporaryDirectoryLink = link
          this.reserveRetainedSetupResource(run, "tmp-alias", link.path, -1, -1)
        },
        onTemporaryDirectoryLink: (link) => {
          setup.temporaryDirectoryLink = link
          this.confirmRetainedSetupResource(
            run,
            "tmp-alias",
            { ...link, realPath: link.path },
            "Retained verification temporary-link ownership reservation changed",
          )
        },
      })
      if (!(await observeRetainedCheckContext(context)))
        throw new Error("Fresh verification resources do not have a readable ownership witness")
      this.runtime.store.atomic((db) =>
        activateRetainedVerificationResources(db, initial.id, phase, check.id, this.runtime.now()),
      )
      return context
    } catch (error) {
      const cleaned =
        error instanceof RetainedSetupProcessTreeUncertainError
          ? this.markRetainedCheckSetupUncertain(initial, phase, check.id, errorText(error))
          : await this.cleanupRetainedCheckSetup(
              initial,
              phase,
              check.id,
              rootDirectory,
              workspace,
              setup.resource,
              setup.dependencyLink,
              setup.temporaryDirectoryLink,
            )
      this.runtime.retainedVerificationAborts.delete(initial.id)
      if (runSignal.aborted || !this.retainedVerificationLive(initial.id)) return undefined
      await this.failRetainedVerification(
        initial,
        cleaned
          ? errorText(error)
          : `${errorText(error)}; partial setup cleanup could not be proven and remains uncertain`,
        run.fence,
      )
      return undefined
    }
  }

  /** Durably records the check's intent; on failure releases the fresh context and reports. */
  private async beginRetainedCheckRow(
    run: RetainedCheckRun,
    context: RetainedCheckContext,
    receiptPath: string,
    inputFingerprint: string,
  ): Promise<ReturnType<typeof beginRetainedVerificationCheck> | undefined> {
    const { initial, phase, check } = run
    try {
      await this.runtime.beforeRetainedCheckBegin?.({
        operationID: initial.id,
        phase,
        checkID: check.id,
      })
      return this.runtime.store.atomic((db) =>
        beginRetainedVerificationCheck(db, {
          operationID: initial.id,
          phase,
          checkID: check.id,
          check: run.effectiveCheck,
          workspace: run.workspace,
          artifact: run.artifact,
          inputFingerprint,
          environmentIdentity: context.environmentIdentity,
          receiptPath,
          contextPath: context.directory,
          createdAt: this.runtime.now(),
        }),
      )
    } catch (error) {
      try {
        await removeRetainedCheckContext(context)
        this.runtime.store.atomic((db) =>
          settleRetainedVerificationResources(
            db,
            initial.id,
            phase,
            check.id,
            "removed",
            this.runtime.now(),
          ),
        )
      } catch {
        this.runtime.store.atomic((db) =>
          settleRetainedVerificationResources(
            db,
            initial.id,
            phase,
            check.id,
            "uncertain",
            this.runtime.now(),
          ),
        )
      }
      this.runtime.retainedVerificationAborts.delete(initial.id)
      await this.failRetainedVerification(initial, errorText(error), run.fence)
      return undefined
    }
  }

  private async dispatchRetainedCheckActivity(
    run: RetainedCheckRun,
    context: RetainedCheckContext,
    checkRow: ReturnType<typeof beginRetainedVerificationCheck>,
    runSignal: AbortSignal,
    receiptPath: string,
  ) {
    const { initial, phase, check, workspace, artifact, deadline } = run
    try {
      const activityIdentity = {
        operationID: initial.id,
        phase,
        checkID: check.id,
        inputFingerprint: checkRow.inputFingerprint,
        workspace: checkRow.workspace,
        artifact: checkRow.artifact,
        contextPath: checkRow.contextPath,
      }
      this.runtime.startCheckActivity({
        id: run.activityID,
        identity: activityIdentity,
        signal: runSignal,
        metadata: {
          kind: "retained",
          projectDirectory: this.runtime.directory,
          planID: initial.planID,
          taskID: initial.taskID,
          attemptID: initial.attemptID,
          operationID: initial.id,
          phase,
          checkID: check.id,
          workspace,
          artifact,
          contextPath: context.directory,
          isolation: retainedCheckIsolationWitness(context),
        },
        run: (signal) =>
          this.runtime.runVerificationCheck(workspace, artifact, check, deadline, receiptPath, {
            environment: context.environment,
            environmentIdentity: context.environmentIdentity,
            ownedUntrackedPaths: context.dependencyLink ? ["node_modules"] : [],
            isolation: retainedCheckIsolationWitness(context),
            signal,
          }),
      })
    } catch (error) {
      this.runtime.store.atomic((db) =>
        markRetainedVerificationCheckUncertain(db, initial.id, phase, check.id, errorText(error)),
      )
      await this.cleanupRetainedCheckResources(
        initial,
        phase,
        check.id,
        context.directory,
        retainedCheckIsolationWitness(context),
        run.fence,
      )
      await this.failRetainedVerification(
        initial,
        `Retained verification check ${phase}:${check.id} is uncertain: ${errorText(error)}`,
        run.fence,
      )
    }
  }

  async cleanupRetainedCheckResources(
    operation: RetainedVerification,
    phase: "task" | "combined",
    checkID: string,
    contextPath: string,
    witness: unknown,
    fence: number,
  ): Promise<void> {
    try {
      const stored = this.runtime.store.atomic((db) =>
        retainedVerificationChecks(db, operation.id, phase).find(
          (check) => check.checkID === checkID,
        ),
      )
      if (!stored)
        throw new Error("Retained check resource ownership has no durable procedure record")
      const check = JSON.parse(stored.checkJSON) as TaskProposal["verification"][number]
      const procedure = retainedProcedurePlan(check.command)
      if (procedure.status !== "supported")
        throw new Error("Retained check procedure binding is no longer supported")
      const expected = {
        operationID: operation.id,
        phase,
        checkID,
        originalWorkspace: operation.originalWorkspace,
        candidateWorkspace: this.retainedVerificationIsolatedWorkspace(operation, phase) ?? "",
        taskDatabase: this.runtime.store.repository.path,
        projectDirectory: this.runtime.directory,
        candidateArtifact: stored.artifact,
        projectIdentity: retainedProjectIdentity(
          this.runtime.directory,
          this.retainedVerificationIsolatedWorkspace(operation, phase) ?? "",
          stored.artifact,
        ),
        procedurePlan: procedure.plan,
      }
      await removeRetainedCheckContextFromWitness(contextPath, witness, expected)
      this.runtime.store.atomic((db) => {
        setRetainedVerificationCheckCleanup(db, operation.id, phase, checkID, "complete")
        settleRetainedVerificationResources(
          db,
          operation.id,
          phase,
          checkID,
          "removed",
          this.runtime.now(),
        )
      })
      this.runtime.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_CONTEXT_CLEANED",
        {
          operationID: operation.id,
          phase,
          checkID,
          contextPath,
          cleanupState: "complete",
        },
      )
    } catch (error) {
      this.runtime.store.atomic((db) => {
        setRetainedVerificationCheckCleanup(db, operation.id, phase, checkID, "failed")
        settleRetainedVerificationResources(
          db,
          operation.id,
          phase,
          checkID,
          "uncertain",
          this.runtime.now(),
        )
      })
      this.runtime.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_CONTEXT_CLEANUP_FAILED",
        {
          operationID: operation.id,
          phase,
          checkID,
          contextPath,
          cleanupState: "failed",
          reason: errorText(error),
          forcedDeletion: false,
        },
      )
      void fence
    }
  }

  private markRetainedCheckSetupUncertain(
    operation: RetainedVerification,
    phase: "task" | "combined",
    checkID: string,
    reason: string,
    contextPath?: string | null,
  ): false {
    this.runtime.store.atomic((db) =>
      settleRetainedVerificationResources(
        db,
        operation.id,
        phase,
        checkID,
        "uncertain",
        this.runtime.now(),
      ),
    )
    this.runtime.store.record(
      operation.planID,
      operation.taskID,
      "RETAINED_VERIFICATION_SETUP_CLEANUP_FAILED",
      {
        operationID: operation.id,
        phase,
        checkID,
        ...(contextPath !== undefined ? { contextPath } : {}),
        reason,
        cleanupState: "failed",
        forcedDeletion: false,
      },
    )
    return false
  }

  private async cleanupRetainedCheckSetup(
    operation: RetainedVerification,
    phase: "task" | "combined",
    checkID: string,
    rootDirectory: string,
    candidateWorkspace: string,
    resource: RetainedCheckSetupResource | undefined,
    dependencyLink: RetainedCheckSetupLink | undefined,
    temporaryDirectoryLink: RetainedCheckSetupLink | undefined,
  ): Promise<boolean> {
    try {
      const persisted = this.runtime.store.atomic((db) =>
        db
          .query<
            {
              resource_name: string
              canonical_path: string
              device: number
              inode: number
              state: string
            },
            [string, string, string]
          >(
            `SELECT resource_name,canonical_path,device,inode,state
             FROM runner_retained_verification_resources
             WHERE operation_id=? AND phase=? AND check_id=? ORDER BY resource_name`,
          )
          .all(operation.id, phase, checkID),
      )
      const expectedSetupPath = join(
        realpathSync(rootDirectory),
        `retained-${operation.id}-${phase}-${checkID}`,
      )
      const root = persisted.find((item) => item.resource_name === "setup-root")
      resource ??= root
        ? {
            path: root.canonical_path,
            realPath: root.canonical_path,
            device: root.device,
            inode: root.inode,
          }
        : undefined
      if (!resource) {
        if (persisted.length || pathEntryExists(expectedSetupPath))
          throw new Error("Partial verification setup has no durable setup-root ownership witness")
        return true
      }
      if (resource.path !== expectedSetupPath)
        throw new Error("Verification setup path does not match its reserved operation identity")
      const persistedDependencyLink = persisted.find(
        (item) => item.resource_name === "dependency-link",
      )
      dependencyLink ??= persistedDependencyLink
        ? {
            path: persistedDependencyLink.canonical_path,
            target: join(resource.path, "dependencies"),
            device: persistedDependencyLink.device,
            inode: persistedDependencyLink.inode,
          }
        : undefined
      const persistedTemporaryLink = persisted.find((item) => item.resource_name === "tmp-alias")
      temporaryDirectoryLink ??= persistedTemporaryLink
        ? {
            path: persistedTemporaryLink.canonical_path,
            target: join(resource.path, "tmp"),
            device: persistedTemporaryLink.device,
            inode: persistedTemporaryLink.inode,
          }
        : undefined
      if (!temporaryDirectoryLink) {
        const aliasPath = retainedTemporaryDirectoryAliasPath({
          operationID: operation.id,
          phase,
          checkID,
        })
        if (aliasPath && pathEntryExists(aliasPath))
          temporaryDirectoryLink = {
            path: aliasPath,
            target: join(resource.path, "tmp"),
            device: -1,
            inode: -1,
          }
      }
      await removeRetainedCheckSetupResources({
        rootDirectory,
        resource,
        candidateWorkspace,
        ...(dependencyLink ? { dependencyLink } : {}),
        ...(temporaryDirectoryLink ? { temporaryDirectoryLink } : {}),
      })
      this.runtime.store.atomic((db) =>
        settleRetainedVerificationResources(
          db,
          operation.id,
          phase,
          checkID,
          "removed",
          this.runtime.now(),
        ),
      )
      this.runtime.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_SETUP_CLEANED",
        {
          operationID: operation.id,
          phase,
          checkID,
          contextPath: resource.path,
          cleanupState: "complete",
        },
      )
      return true
    } catch (error) {
      return this.markRetainedCheckSetupUncertain(
        operation,
        phase,
        checkID,
        errorText(error),
        resource?.path ?? null,
      )
    }
  }

  private async retainedEvidenceMissing(
    operation: RetainedVerification,
    phase: "task",
    assertions: TaskProposal["acceptance"],
    workspace: string,
    artifact: string,
    receipts: CheckReceipt[],
  ): Promise<string[]> {
    const missing: string[] = []
    const probes = new ProbeRepository(this.runtime.store.repository)
    const resources = new ResourceRepository(this.runtime.store.repository)
    const target = { kind: "task", taskID: operation.taskID } as const
    const probeDefinition = probes.definitionForTarget(target)
    const probeRuns = probeDefinition ? probes.runsForAttempt(operation.attemptID) : []
    const basis = retainedVerificationProbeBasis(operation, phase)
    const currentInputs = basis.inputs
    const currentEnvironment = basis.environment
    for (const assertion of assertions) {
      for (const evidence of assertion.evidence) {
        if (
          evidence.kind === "verification" &&
          !receipts.some(
            (receipt) =>
              receipt.id === evidence.verificationID &&
              this.runtime.store.sameArtifact(receipt.artifact, artifact) &&
              this.runtime.store.sameArtifact(receipt.inputIdentity, artifact) &&
              receipt.exitCode === 0 &&
              !receipt.timedOut,
          )
        )
          missing.push(`${assertion.id}:verification`)
        if (evidence.kind === "artifact" && !(await artifactExists(workspace, evidence.reference)))
          missing.push(`${assertion.id}:${evidence.reference}`)
      }
      const scenarios =
        probeDefinition?.scenarios.filter((scenario) =>
          scenario.acceptanceIDs.includes(assertion.id),
        ) ?? []
      for (const scenario of scenarios) {
        const passed = probeRuns.some((run) => {
          if (
            run.attemptID !== operation.attemptID ||
            run.sessionID !== operation.originalSessionID ||
            run.producer.sessionID !== operation.owner ||
            run.producer.agent !== "architect" ||
            fingerprint(run.target) !== fingerprint(target) ||
            run.definitionID !== probeDefinition!.definitionID ||
            run.definitionRevision !== probeDefinition!.revision ||
            run.scenarioID !== scenario.id ||
            run.candidate.revision !== artifact ||
            run.candidate.workspace !== workspace ||
            fingerprint(run.procedure) !== fingerprint(scenario.procedure) ||
            fingerprint(run.inputs) !== fingerprint(currentInputs) ||
            fingerprint(run.environment) !== fingerprint(currentEnvironment)
          )
            return false
          try {
            const ownership = resources.resourcesForRun(run.runID)
            const execution = resources.execution(run.runID)
            if (
              ownership.length === 0 ||
              execution?.phase !== "finished" ||
              !this.retainedProbeResourcesAreIsolated(operation, workspace, ownership) ||
              ownership.some(
                (resource) =>
                  resource.runID !== run.runID ||
                  resource.owner.projectDirectory !== operation.projectDirectory ||
                  resource.owner.planID !== operation.planID ||
                  resource.owner.taskID !== operation.taskID ||
                  resource.owner.attemptID !== operation.attemptID ||
                  resource.owner.sessionID !== operation.originalSessionID ||
                  fingerprint(resource.owner.producer) !== fingerprint(run.producer) ||
                  fingerprint(resource.owner.candidate) !== fingerprint(run.candidate) ||
                  fingerprint(resource.owner.environment) !== fingerprint(run.environment),
              )
            )
              return false
            const eligibility = probes.eligibility(run.runID, {
              candidate: { revision: artifact, workspace },
              procedure: scenario.procedure,
              inputs: currentInputs,
              environment: currentEnvironment,
            })
            return eligibility.eligible && eligibility.satisfied
          } catch {
            return false
          }
        })
        if (!passed) missing.push(`${assertion.id}:probe:${scenario.id}`)
      }
    }
    return missing
  }

  private async removeRetainedVerificationWorkspace(
    operation: RetainedVerification,
    phase: "task" | "combined",
    fence: number,
  ): Promise<"complete" | "failed" | "pending"> {
    const workspace = this.retainedVerificationIsolatedWorkspace(operation, phase)
    const state =
      (phase === "task" ? operation.taskWorkspaceState : operation.combinedWorkspaceState) ?? null
    if (!workspace) return "complete"
    if (!state) return "pending"
    const artifact = phase === "task" ? operation.artifact : operation.combinedArtifact
    if (!artifact) return "pending"
    let recordedWorkspace = workspace
    try {
      const checks = this.runtime.store.atomic((db) =>
        retainedVerificationChecks(db, operation.id, phase),
      )
      for (const check of checks) {
        if (check.state !== "completed" || !check.receipt)
          throw new Error("Retained check activity is not conclusively complete")
        const receipt = JSON.parse(check.receipt) as CheckReceipt
        if (!checkResourcesSettled(receipt))
          throw new Error("Retained check process cleanup remains uncertain")
        if (check.cleanupState !== "complete") {
          const resourcesCleaned = await this.cleanupRetainedCheckSetup(
            operation,
            phase,
            check.checkID,
            this.runtime.dataDirectory,
            workspace,
            undefined,
            undefined,
            undefined,
          )
          if (resourcesCleaned)
            await this.cleanupRetainedCheckResources(
              operation,
              phase,
              check.checkID,
              check.contextPath,
              receipt.isolation,
              fence,
            )
        }
      }
      const remainingResources = this.runtime.store.atomic((db) =>
        db
          .query<{ state: string }, [string, string]>(
            "SELECT state FROM runner_retained_verification_resources WHERE operation_id=? AND phase=?",
          )
          .all(operation.id, phase)
          .some((resource) => resource.state !== "removed"),
      )
      const checkCleanupPending = this.runtime.store.atomic((db) =>
        retainedVerificationChecks(db, operation.id, phase).some(
          (check) => check.cleanupState !== "complete",
        ),
      )
      if (remainingResources || checkCleanupPending)
        throw new Error("Retained verification check resources remain unsettled")

      const candidates =
        state === "reserved" || state === "uncertain"
          ? startupWorktreeCandidates(workspace)
          : [workspace]
      const native = await this.runtime.host.worktrees()
      const matches = native.filter((item) =>
        candidates.some((candidate) => resolve(item) === resolve(candidate)),
      )
      if (matches.length > 1)
        throw new Error("Multiple native worktrees match the retained workspace reservation")
      const owned = matches[0]
      if (!owned) {
        const existing = candidates.filter((candidate) => existsSync(candidate))
        const gitWorktrees = await this.registeredGitWorktrees()
        const registered = candidates.filter((candidate) =>
          gitWorktrees.includes(resolve(candidate)),
        )
        if (existing.length > 1 || registered.length > 1)
          throw new Error(
            "Multiple retained workspace paths exist; preserve them for reconciliation",
          )
        if (existing.length && !registered.length)
          throw new Error("Retained checkout exists without native ownership; preserve it")
        if (registered.length) {
          recordedWorkspace = registered[0]!
          const removalIntent = this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
            const current = retainedVerification(db, operation.id)
            if (!current) return false
            setRetainedVerificationWorkspace(db, current, phase, recordedWorkspace, "owned")
            this.runtime.store.record(
              operation.planID,
              operation.taskID,
              "RETAINED_VERIFICATION_WORKSPACE_REMOVAL_INTENDED",
              {
                operationID: operation.id,
                phase,
                workspace: recordedWorkspace,
              },
            )
            return true
          })
          if (!removalIntent) return "pending"
          await this.runtime.host.removeWorktree(recordedWorkspace)
        }
        const nativeAfterAbsent = await this.runtime.host.worktrees()
        const gitAfterAbsent = await registeredWorktreePaths(this.runtime.directory)
        if (
          nativeAfterAbsent.some((item) =>
            candidates.some((candidate) => resolve(item) === resolve(candidate)),
          ) ||
          gitAfterAbsent.some((item) =>
            candidates.some((candidate) => resolve(item) === resolve(candidate)),
          ) ||
          candidates.some((candidate) => existsSync(candidate))
        )
          throw new Error("Retained native workspace removal is not confirmed absent")
      } else {
        recordedWorkspace = owned
        if (
          realpathSync(dirname(owned)) !== realpathSync(dirname(workspace)) ||
          samePhysicalWorkspace(owned, operation.originalWorkspace) ||
          samePhysicalWorkspace(owned, this.runtime.directory) ||
          realpathSync(await gitAsync(owned, ["rev-parse", "--show-toplevel"])) !==
            realpathSync(owned) ||
          (await gitAsync(owned, ["rev-parse", "HEAD"])) !== artifact ||
          (await gitAsync(owned, ["status", "--porcelain", "--untracked-files=all"])) ||
          (await gitAsync(owned, ["ls-files", "-u", "-z"]))
        )
          throw new Error("Retained checkout identity or clean state changed; preserve it")
        const removalIntent = this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
          const current = retainedVerification(db, operation.id)
          if (!current) return false
          setRetainedVerificationWorkspace(db, current, phase, owned, "owned")
          this.runtime.store.record(
            operation.planID,
            operation.taskID,
            "RETAINED_VERIFICATION_WORKSPACE_REMOVAL_INTENDED",
            {
              operationID: operation.id,
              phase,
              workspace: owned,
            },
          )
          return true
        })
        if (!removalIntent) return "pending"
        await this.runtime.host.removeWorktree(owned)
      }
      const currentNative = await this.runtime.host.worktrees()
      const currentGit = await registeredWorktreePaths(this.runtime.directory)
      if (
        candidates.some((candidate) => existsSync(candidate)) ||
        currentGit.some((item) =>
          candidates.some((candidate) => resolve(item) === resolve(candidate)),
        ) ||
        currentNative.some((item) =>
          candidates.some((candidate) => resolve(item) === resolve(candidate)),
        )
      )
        throw new Error("Native adapter did not confirm retained checkout removal")
      const retired = await this.runtime.host.retireWorktreeLocation?.(recordedWorkspace)
      if (retired !== undefined && retired !== "evicted" && retired !== "not-loaded")
        throw new Error(`Native checkout location retirement is ${retired}`)
      this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
        const current = retainedVerification(db, operation.id)
        if (current)
          setRetainedVerificationWorkspace(db, current, phase, recordedWorkspace, "removed")
      })
      this.runtime.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_WORKSPACE_CLEANED",
        {
          operationID: operation.id,
          phase,
          workspace: recordedWorkspace,
          cleanupState: "complete",
          forcedDeletion: false,
        },
      )
      return "complete"
    } catch (error) {
      this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
        const current = retainedVerification(db, operation.id)
        if (current)
          setRetainedVerificationWorkspace(db, current, phase, recordedWorkspace, "uncertain")
      })
      this.runtime.store.record(
        operation.planID,
        operation.taskID,
        "RETAINED_VERIFICATION_WORKSPACE_CLEANUP_FAILED",
        {
          operationID: operation.id,
          phase,
          workspace: recordedWorkspace,
          cleanupState: "failed",
          reason: errorText(error),
          forcedDeletion: false,
        },
      )
      return "failed"
    }
  }

  async reconcileTerminalRetainedVerifications(fence: number): Promise<void> {
    const terminalOperations = this.runtime.store
      .atomic((db) => retainedVerificationsForProject(db, this.runtime.directory))
      .filter((operation) => isTerminalRetainedState(operation.state))
    const terminalIDs = new Set(terminalOperations.map((operation) => operation.id))
    for (const operationID of this.runtime.terminalRetainedVerificationCleanupChecks.keys())
      if (!terminalIDs.has(operationID))
        this.runtime.terminalRetainedVerificationCleanupChecks.delete(operationID)
    const checkedAt = this.runtime.now()
    const operations = terminalOperations.filter((operation) => {
      if (!this.terminalRetainedVerificationCleanupRecordedComplete(operation)) return true
      const previous = this.runtime.terminalRetainedVerificationCleanupChecks.get(operation.id)
      if (!previous || previous.updatedAt !== operation.updatedAt) return true
      const elapsed = checkedAt - previous.checkedAt
      return elapsed < 0 || elapsed >= WORKTREE_CLEANUP_FALLBACK_MS
    })
    if (!operations.length) return

    let inventory: WorktreeInventory
    try {
      inventory = await this.readWorktreeInventory()
    } catch {
      this.deferTerminalCleanupChecks(operations, checkedAt)
      return
    }
    for (const original of operations)
      await this.reconcileTerminalOperation(original, inventory, fence)
  }

  private async readWorktreeInventory(): Promise<WorktreeInventory> {
    const native = await this.runtime.host.worktrees()
    return { native, gitWorktrees: await this.registeredGitWorktrees() }
  }

  private async registeredGitWorktrees(): Promise<string[]> {
    return registeredWorktreePaths(this.runtime.directory)
  }

  /** With no worktree inventory to judge by, remember already-clean operations so they are not rechecked at once. */
  private deferTerminalCleanupChecks(operations: RetainedVerification[], checkedAt: number) {
    for (const operation of operations) {
      const current = this.runtime.store.atomic((db) => retainedVerification(db, operation.id))
      if (
        current &&
        current.updatedAt === operation.updatedAt &&
        this.terminalRetainedVerificationCleanupRecordedComplete(current)
      )
        this.runtime.terminalRetainedVerificationCleanupChecks.set(operation.id, {
          updatedAt: current.updatedAt,
          checkedAt,
        })
    }
  }

  private async reconcileTerminalOperation(
    original: RetainedVerification,
    inventory: WorktreeInventory,
    fence: number,
  ) {
    let operation = this.runtime.store.atomic((db) => retainedVerification(db, original.id))
    if (!operation || !isTerminalRetainedState(operation.state)) return
    if (operation.state === "cancelled") {
      try {
        await this.runtime.recoverCancelledRetainedChecks(operation.id)
      } catch {
        // Keep the terminal operation and its native resources discoverable.
      }
      operation = this.runtime.store.atomic((db) => retainedVerification(db, original.id))
      if (!operation) return
    }

    let cleanupComplete = true
    const workspaceResults = new Map<"task" | "combined", "complete" | "failed" | "pending">()
    for (const phase of ["task", "combined"] as const) {
      const outcome = await this.reconcileTerminalPhase(operation, phase, inventory, fence)
      if (outcome.result) workspaceResults.set(phase, outcome.result)
      if (!outcome.complete) cleanupComplete = false
    }

    const refreshed = this.runtime.store.atomic((db) => retainedVerification(db, operation.id))
    if (!refreshed) return
    const taskResult = workspaceResults.get("task")
    const combinedResult = workspaceResults.get("combined")
    const workspaceUnresolved = [
      [refreshed.taskWorkspace, refreshed.taskWorkspaceState, taskResult],
      [refreshed.combinedWorkspace, refreshed.combinedWorkspaceState, combinedResult],
    ].some(
      ([workspace, state, result]) =>
        Boolean(workspace) && (state !== "removed" || (result && result !== "complete")),
    )
    cleanupComplete &&= !workspaceUnresolved
    this.recordTerminalCleanupState(refreshed, cleanupComplete, workspaceResults, fence)
    const current = this.runtime.store.atomic((db) => retainedVerification(db, refreshed.id))
    if (
      cleanupComplete &&
      current &&
      isTerminalRetainedState(current.state) &&
      this.terminalRetainedVerificationCleanupRecordedComplete(current)
    )
      this.runtime.terminalRetainedVerificationCleanupChecks.set(current.id, {
        updatedAt: current.updatedAt,
        checkedAt: this.runtime.now(),
      })
    else this.runtime.terminalRetainedVerificationCleanupChecks.delete(refreshed.id)
  }

  /** Persists the operation's terminal cleanup state when it changed, with the per-phase results. */
  private recordTerminalCleanupState(
    refreshed: RetainedVerification,
    cleanupComplete: boolean,
    workspaceResults: Map<"task" | "combined", "complete" | "failed" | "pending">,
    fence: number,
  ) {
    const cleanupState = cleanupComplete ? "complete" : "failed"
    if (refreshed.cleanupState === cleanupState) return
    this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = retainedVerification(db, refreshed.id)
      if (!current) return
      saveRetainedVerification(db, {
        ...current,
        cleanupState,
        updatedAt: this.runtime.now(),
      })
      this.runtime.store.record(
        current.planID,
        current.taskID,
        cleanupComplete
          ? "RETAINED_VERIFICATION_TERMINAL_CLEANUP_COMPLETED"
          : "RETAINED_VERIFICATION_TERMINAL_CLEANUP_PENDING",
        {
          operationID: current.id,
          workspaces: {
            task: current.taskWorkspaceState,
            combined: current.combinedWorkspaceState,
          },
          results: Object.fromEntries(workspaceResults),
        },
      )
    })
  }

  /** One phase of a terminal operation: clean its check resources, then its workspace once they are gone. */
  private async reconcileTerminalPhase(
    operation: RetainedVerification,
    phase: "task" | "combined",
    inventory: WorktreeInventory,
    fence: number,
  ): Promise<{ complete: boolean; result?: "complete" | "failed" | "pending" }> {
    const workspace = this.retainedVerificationIsolatedWorkspace(operation, phase)
    const workspaceState =
      (phase === "task" ? operation.taskWorkspaceState : operation.combinedWorkspaceState) ?? null
    const checks = await this.cleanTerminalPhaseChecks(operation, phase, workspace, fence)

    const candidates =
      workspace && (workspaceState === "reserved" || workspaceState === "uncertain")
        ? startupWorktreeCandidates(workspace)
        : workspace
          ? [workspace]
          : []
    const inventoryHasWorkspace = candidates.some(
      (candidate) =>
        inventory.native.some((entry) => resolve(entry) === resolve(candidate)) ||
        inventory.gitWorktrees.includes(resolve(candidate)) ||
        existsSync(candidate),
    )
    const workspaceNeedsCleanup = Boolean(
      workspace && (workspaceState !== "removed" || inventoryHasWorkspace),
    )
    if (!checks.settled) {
      const stillOwned = checks.refreshedCount > 0 || checks.remainingResources
      if (workspaceNeedsCleanup) return { complete: false, result: "pending" }
      return { complete: !stillOwned }
    }
    if (workspaceNeedsCleanup) {
      const result = await this.removeRetainedVerificationWorkspace(operation, phase, fence)
      return { complete: result === "complete", result }
    }
    if (workspaceState !== null && workspaceState !== "removed")
      return { complete: false, result: "pending" }
    return { complete: true }
  }

  /** Cleans each completed check's resources; settled only when every check and resource is gone. */
  private async cleanTerminalPhaseChecks(
    operation: RetainedVerification,
    phase: "task" | "combined",
    workspace: string | undefined,
    fence: number,
  ) {
    const checks = this.runtime.store.atomic((db) =>
      retainedVerificationChecks(db, operation.id, phase),
    )
    let checksSettled = true
    for (const check of checks) {
      if (check.state !== "completed" || !check.receipt) {
        checksSettled = false
        break
      }
      let receipt: CheckReceipt
      try {
        receipt = JSON.parse(check.receipt) as CheckReceipt
      } catch {
        checksSettled = false
        break
      }
      if (!checkResourcesSettled(receipt)) {
        checksSettled = false
        break
      }
      const resourcePending = this.runtime.store.atomic((db) =>
        db
          .query<{ state: string }, [string, string, string]>(
            "SELECT state FROM runner_retained_verification_resources WHERE operation_id=? AND phase=? AND check_id=?",
          )
          .all(operation.id, phase, check.checkID)
          .some((resource) => resource.state !== "removed"),
      )
      if (check.cleanupState === "complete" && !resourcePending) continue
      const setupClean = await this.cleanupRetainedCheckSetup(
        operation,
        phase,
        check.checkID,
        this.runtime.dataDirectory,
        workspace ?? check.workspace,
        undefined,
        undefined,
        undefined,
      )
      if (setupClean)
        await this.cleanupRetainedCheckResources(
          operation,
          phase,
          check.checkID,
          check.contextPath,
          receipt.isolation,
          fence,
        )
    }
    const refreshedChecks = this.runtime.store.atomic((db) =>
      retainedVerificationChecks(db, operation.id, phase),
    )
    const remainingResources = this.runtime.store.atomic((db) =>
      db
        .query<{ state: string }, [string, string]>(
          "SELECT state FROM runner_retained_verification_resources WHERE operation_id=? AND phase=?",
        )
        .all(operation.id, phase)
        .some((resource) => resource.state !== "removed"),
    )
    checksSettled &&= refreshedChecks.every(
      (check) =>
        check.state === "completed" && Boolean(check.receipt) && check.cleanupState === "complete",
    )
    checksSettled &&= !remainingResources
    return { settled: checksSettled, refreshedCount: refreshedChecks.length, remainingResources }
  }

  private terminalRetainedVerificationCleanupRecordedComplete(operation: RetainedVerification) {
    const workspaceSettled = (workspace: string | null, state: string | null) =>
      workspace === null ? state === null : state === "removed"
    return (
      operation.cleanupState === "complete" &&
      workspaceSettled(operation.taskWorkspace, operation.taskWorkspaceState) &&
      workspaceSettled(
        operation.combinedWorkspace ?? null,
        operation.combinedWorkspaceState ?? null,
      )
    )
  }

  private async reconcileInterruptedRetainedCheckSetup(
    operation: RetainedVerification,
    phase: "task" | "combined",
    check: TaskProposal["verification"][number],
    candidateWorkspace: string,
    fence: number,
  ): Promise<boolean> {
    const existingCheck = this.runtime.store.atomic((db) =>
      retainedVerificationChecks(db, operation.id, phase).some((item) => item.checkID === check.id),
    )
    if (existingCheck) return false
    const resources = this.runtime.store.atomic((db) =>
      db
        .query<
          {
            resource_name: string
            canonical_path: string
            device: number
            inode: number
            state: string
          },
          [string, string, string]
        >(
          `SELECT resource_name,canonical_path,device,inode,state
           FROM runner_retained_verification_resources
           WHERE operation_id=? AND phase=? AND check_id=? ORDER BY resource_name`,
        )
        .all(operation.id, phase, check.id),
    )
    if (!resources.length) return false
    // A restarted runtime has no completed installer/termination observation.
    // Ownership identifies resources; it does not establish that their writer stopped.
    const reason = `Interrupted retained verification setup ${phase}:${check.id} has unknown installer activity in ${candidateWorkspace}; preserve its resources`
    this.markRetainedCheckSetupUncertain(operation, phase, check.id, reason)
    await this.failRetainedVerification(operation, reason, fence)
    return true
  }

  /**
   * Record the pass: the task takes the verified commit as its accepted artifact
   * and a plan stopped on that task's failure runs again. Combined acceptance is
   * the ordinary combined check that follows; nothing here accepts the plan.
   */
  private async acceptRetainedCandidate(
    initial: RetainedVerification,
    workspace: string,
    receipts: CheckReceipt[],
    fence: number,
  ): Promise<void> {
    if (initial.repair) {
      try {
        const plan = this.runtime.store.plan(initial.planID)
        const attempt = this.runtime.store
          .attempts(initial.planID)
          .find((candidate) => candidate.id === initial.attemptID)
        if (!plan || !attempt) throw new Error("Retained repair binding disappeared")
        await this.runtime.observeRetainedRepairCandidate(plan, attempt, initial.repair)
      } catch (error) {
        await this.failRetainedVerification(initial, errorText(error), fence)
        return
      }
    }
    if (!(await this.retainedWorkspaceUnchanged(workspace, initial.artifact))) {
      await this.failRetainedVerification(
        initial,
        "Retained candidate changed after its checks",
        fence,
      )
      return
    }
    const contextCleanup = this.runtime.store.atomic((db) =>
      retainedVerificationChecks(db, initial.id).every((row) => row.cleanupState === "complete"),
    )
    const workspaceCleanup = await this.removeRetainedVerificationWorkspace(initial, "task", fence)
    const cleanupState = workspaceCleanup === "complete" && contextCleanup ? "complete" : "failed"
    this.runtime.store.fenced(this.runtime.owner, fence, (db) => {
      const current = retainedVerification(db, initial.id)
      const currentPlan = this.runtime.store.plan(initial.planID)
      const currentTask = this.runtime.store.repository.get(initial.taskID)
      const latestAttempt = this.runtime.store
        .attempts(initial.planID)
        .filter((candidate) => candidate.task_id === initial.taskID)
        .at(-1)
      const currentNode = this.runtime.store
        .nodes(initial.planID)
        .find((candidate) => candidate.task_id === initial.taskID)
      if (
        !current ||
        !["pending", "task-checks"].includes(current.state) ||
        !currentPlan ||
        currentPlan.revision !== initial.planRevision ||
        !["blocked", "accepted", "cleanup-blocked"].includes(currentPlan.state) ||
        !currentTask ||
        currentTask.revision !== initial.taskRevision ||
        !sameProject(currentTask.provenance.projectID, this.runtime.projectID) ||
        currentTask.provenance.projectDirectory !== this.runtime.directory ||
        this.runtime.store.repository.taskDisposition(initial.taskID) !== undefined ||
        latestAttempt?.id !== initial.attemptID ||
        latestAttempt.session_id !== initial.originalSessionID ||
        latestAttempt.message_id !== initial.originalMessageID ||
        realpathSync(latestAttempt.workspace) !== initial.originalWorkspace ||
        !currentNode ||
        !["accepted", "blocked", "failed", "verifying", "running", "ready"].includes(
          currentNode.state,
        ) ||
        (currentNode.artifact !== null && currentNode.artifact !== initial.artifact) ||
        (initial.repair &&
          (latestAttempt.artifact !== initial.repair.previousArtifact ||
            !this.runtime.retainedRepairCandidateCurrent(
              currentPlan,
              latestAttempt,
              initial.repair,
            )))
      )
        return
      const failureOwnsBlock = Boolean(
        currentPlan.state === "blocked" &&
        currentPlan.reason !== null &&
        ((currentNode.state === "failed" &&
          latestAttempt.state === "failed" &&
          (currentPlan.reason === currentNode.reason ||
            currentPlan.reason ===
              `Task ${currentNode.task_id}: ${currentNode.reason ?? currentNode.state}`)) ||
          (currentNode.state === "verifying" &&
            latestAttempt.state === "verifying" &&
            currentPlan.reason.startsWith("Required evidence missing:"))),
      )
      db.query(
        "UPDATE runner_attempts SET state=lz_runner_transition('attempt',state,'accepted'),artifact=? WHERE id=? AND state IN ('running','verifying')",
      ).run(initial.artifact, initial.attemptID)
      if (currentNode.state !== "accepted") {
        db.query(
          "UPDATE runner_nodes SET artifact=? WHERE plan_id=? AND task_id=? AND state=?",
        ).run(initial.artifact, initial.planID, initial.taskID, currentNode.state)
        this.runtime.store.move(initial.planID, initial.taskID, "RETAINED_ACCEPT")
      }
      let resumedForDependencies = false
      if (failureOwnsBlock) {
        const resumed = db
          .query(
            `UPDATE runner_plans SET state=lz_runner_transition('plan',state,'running'),reason=NULL,version=version+1
             WHERE id=? AND state='blocked' AND reason=?`,
          )
          .run(initial.planID, currentPlan.reason).changes
        if (resumed !== 1) throw new Error("Plan changed before retained task dependency release")
        resumedForDependencies = true
      }
      saveRetainedVerification(db, {
        ...current,
        state: "accepted",
        failureReason: null,
        cleanupState,
        taskWorkspaceState: workspaceCleanup === "complete" ? "removed" : "uncertain",
        updatedAt: this.runtime.now(),
      })
      this.runtime.store.record(initial.planID, initial.taskID, "RETAINED_CANDIDATE_ACCEPTED", {
        operationID: initial.id,
        taskRevision: initial.taskRevision,
        attemptID: initial.attemptID,
        artifact: initial.artifact,
        checks: receipts,
        resumedForDependencies,
        cleanupState,
        originalAttemptStatePreserved: true,
        originalSessionMessageRouteUsagePreserved: true,
        resourceHoldsPreserved: true,
      })
      this.runtime.outcome(
        initial.planID,
        {
          status: "task-accepted",
          taskID: initial.taskID,
          attemptID: initial.attemptID,
          artifact: initial.artifact,
          retainedVerificationID: initial.id,
          evidence: receipts.map((receipt) => receipt.id),
          cleanupState,
          resumedForDependencies,
        },
        true,
      )
    })
  }

  /** Verify the given commit in a temporary worktree and record pass or fail. */
  async advanceRetainedVerification(
    initial: RetainedVerification,
    fence: number,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) return
    let operation = this.runtime.store.atomic((db) => retainedVerification(db, initial.id))
    if (!operation || !["pending", "task-checks"].includes(operation.state)) return
    const plan = this.runtime.store.plan(operation.planID)
    if (!plan) return
    try {
      if (!this.retainedVerificationLive(operation.id))
        throw new Error("Retained verification plan, task or attempt changed")
      if (operation.repair) {
        const operationAttemptID = operation.attemptID
        const attempt = this.runtime.store
          .attempts(plan.id)
          .find((candidate) => candidate.id === operationAttemptID)
        if (!attempt) throw new Error("Retained repair attempt disappeared")
        await this.runtime.observeRetainedRepairCandidate(plan, attempt, operation.repair)
      }
    } catch (error) {
      await this.failRetainedVerification(operation, errorText(error), fence)
      return
    }
    const task = this.runtime.store.repository.get(operation.taskID)
    if (!task) {
      await this.failRetainedVerification(
        operation,
        "Retained task specification is unavailable",
        fence,
      )
      return
    }
    for (const check of task.proposal.verification)
      if (
        await this.reconcileInterruptedRetainedCheckSetup(
          operation,
          "task",
          check,
          operation.taskWorkspace ?? "",
          fence,
        )
      )
        return
    const workspace = await this.ensureRetainedVerificationWorkspace(
      operation,
      "task",
      operation.artifact,
      fence,
    )
    if (!workspace) return
    const refreshed = this.runtime.store.atomic((db) => retainedVerification(db, initial.id))
    if (!refreshed) return
    operation = refreshed
    if (operation.state === "pending") {
      const updated = await this.setRetainedVerificationState(operation, "task-checks", null, fence)
      if (!updated) return
      operation = updated
    }
    const artifact = operation.artifact
    const receipts = await this.runRetainedVerificationChecks(
      operation,
      "task",
      task.proposal.verification,
      workspace,
      artifact,
      fence,
      signal,
    )
    if (!receipts || !this.retainedVerificationLive(operation.id)) return
    const failed = receipts.find(
      (receipt) => !checkSucceeded(receipt) || receipt.inputIdentity !== artifact,
    )
    if (failed) {
      await this.failRetainedVerification(operation, checkFailureReason(failed), fence)
      return
    }
    const missing = await this.retainedEvidenceMissing(
      operation,
      "task",
      task.proposal.acceptance,
      workspace,
      artifact,
      receipts,
    )
    if (missing.length) {
      await this.failRetainedVerification(
        operation,
        `Required retained task evidence missing: ${missing.join(", ")}`,
        fence,
      )
      return
    }
    await this.acceptRetainedCandidate(operation, workspace, receipts, fence)
  }
}
