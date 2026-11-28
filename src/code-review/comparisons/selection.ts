import { z } from "zod"
import { diffHunks, treeFiles } from "./git.ts"
import type {
  CodeReviewComparison,
  CodeReviewComparisonIdentity,
  CodeReviewResolveInput,
  CodeReviewSide,
} from "../contract.ts"
import type { TaskRepository } from "../../storage.ts"
import { PlanInput } from "../../runner/schema.ts"
import type { AttemptRow, NodeRow, PlanRow, RunnerStore } from "../../runner/store.ts"
import { taskChainBase } from "../../runner/task-chain-base.ts"
import type { ComparisonBlob, ComparisonFile } from "./store.ts"
import { captureLive } from "./live-capture.ts"
import { gitFileEntry, liveFileRows } from "./inventory.ts"

export type ReviewAttempt = Pick<
  AttemptRow,
  | "id"
  | "plan_id"
  | "task_id"
  | "number"
  | "state"
  | "started_at"
  | "workspace"
  | "base_commit"
  | "artifact"
>

export const REVIEW_ATTEMPT_COLUMNS =
  "a.id,a.plan_id,a.task_id,a.number,a.state,a.started_at,a.workspace,a.base_commit,a.artifact"

export type ComparisonSelection = {
  selectedPlanID: string | null
  selectedAttemptID: string | null
  base: string
  head: string
  planContext: CodeReviewComparison["planContext"]
  mainSides: CodeReviewSide[]
  files?: ComparisonFile[]
  blobs?: ComparisonBlob[]
  snapshotID: string | null
  capturedAt: number | null
  attribution: CodeReviewComparisonIdentity["attribution"]
}

type ResolvedPlan = {
  base: string
  head: string
  nodes: NodeRow[]
  taskFiles: Record<string, string[]>
  dependencies: { prerequisite: string; successor: string }[]
}

export class CodeReviewSelectionResolver {
  constructor(
    readonly repository: TaskRepository,
    readonly runner: RunnerStore,
  ) {}

  select(
    taskID: string,
    input: CodeReviewResolveInput,
    signal: AbortSignal,
  ): Promise<ComparisonSelection> {
    switch (input.mode) {
      case "task":
        return Promise.resolve(this.taskSelection(taskID))
      case "attempt":
        return Promise.resolve(this.attemptSelection(taskID, input.attemptID!))
      case "since":
        return Promise.resolve(
          this.sinceSelection(taskID, input.baseAttemptID!, input.headAttemptID!),
        )
      case "plan":
        return this.planSelection(taskID, input.planID!, signal)
      case "live":
        return this.liveSelection(taskID, input.attemptID, signal)
    }
  }

  private taskSelection(taskID: string): ComparisonSelection {
    const latest = this.latestTaskArtifact(taskID)
    if (!latest?.attempt.artifact) throw new Error("Task has no retained artifact to compare")
    return this.committedSelection(
      latest.planID,
      latest.attempt.id,
      this.taskChainBase(latest.attempt),
      latest.attempt.artifact,
    )
  }

  private attemptSelection(taskID: string, attemptID: string): ComparisonSelection {
    const attempt = this.requireAttempt(taskID, attemptID)
    if (!attempt.artifact) throw new Error("Attempt has no retained artifact to compare")
    return this.committedSelection(
      attempt.plan_id,
      attempt.id,
      attempt.base_commit,
      attempt.artifact,
    )
  }

  private sinceSelection(
    taskID: string,
    baseAttemptID: string,
    headAttemptID: string,
  ): ComparisonSelection {
    const prior = this.requireAttempt(taskID, baseAttemptID)
    const selected = this.requireAttempt(taskID, headAttemptID)
    if (!prior.artifact || !selected.artifact)
      throw new Error("Since-review selections must both have retained artifacts")
    if (attemptFollows(prior, selected))
      throw new Error("The since-review baseline must not follow its selected revision")
    return this.committedSelection(selected.plan_id, selected.id, prior.artifact, selected.artifact)
  }

  private async planSelection(
    taskID: string,
    planID: string,
    signal: AbortSignal,
  ): Promise<ComparisonSelection> {
    const plan = this.runner.plan(planID)
    if (!plan) throw new Error("Plan is unavailable in this project")
    const body = PlanInput.parse(JSON.parse(plan.body))
    const nodes = this.runner.nodes(plan.id)
    if (!nodes.some((node) => node.task_id === taskID))
      throw new Error("Task is not a member of the selected plan")
    const resolved = await this.planComparison(plan, body, nodes, signal)
    return {
      ...this.committedSelection(plan.id, null, resolved.base, resolved.head),
      planContext: {
        taskIDs: nodes.map((node) => node.task_id),
        dependencies: resolved.dependencies,
        taskFiles: resolved.taskFiles,
      },
    }
  }

  private async liveSelection(
    taskID: string,
    attemptID: string | undefined,
    signal: AbortSignal,
  ): Promise<ComparisonSelection> {
    const attempt = attemptID ? this.requireAttempt(taskID, attemptID) : this.latestAttempt(taskID)
    if (!attempt) throw new Error("Task has no assigned workspace to capture")
    const base = this.taskChainBase(attempt)
    const live = await captureLive(this.repository.projectDirectory, attempt, base, signal)
    const [baseTree, headTree] = await Promise.all([
      treeFiles(this.repository.projectDirectory, base, signal),
      treeFiles(this.repository.projectDirectory, live.headRevision, signal),
    ])
    const baseEntries = new Map([...baseTree].map(([path, file]) => [path, gitFileEntry(file)]))
    const headEntries = new Map([...headTree].map(([path, file]) => [path, gitFileEntry(file)]))
    return {
      selectedPlanID: attempt.plan_id,
      selectedAttemptID: attempt.id,
      base,
      head: live.headRevision,
      planContext: null,
      mainSides: ["base", "head", "staged", "unstaged", "untracked"],
      files: liveFileRows(baseEntries, headEntries, live),
      blobs: live.blobs,
      snapshotID: live.snapshotID,
      capturedAt: live.capturedAt,
      attribution: live.attribution,
    }
  }

  private committedSelection(
    planID: string | null,
    attemptID: string | null,
    base: string,
    head: string,
  ): ComparisonSelection {
    return {
      selectedPlanID: planID,
      selectedAttemptID: attemptID,
      base,
      head,
      planContext: null,
      mainSides: ["base", "head"],
      snapshotID: null,
      capturedAt: null,
      attribution: "committed",
    }
  }

  private requireAttempt(taskID: string, attemptID: string): ReviewAttempt {
    const attempt = this.repository.read((db) =>
      db
        .query<ReviewAttempt, [string, string, string]>(
          `SELECT ${REVIEW_ATTEMPT_COLUMNS}
           FROM runner_attempts a
           WHERE a.project_directory=? AND a.task_id=? AND a.id=?`,
        )
        .get(this.repository.projectDirectory, taskID, attemptID),
    )
    if (!attempt) throw new Error("Attempt is not part of this task and project")
    return attempt
  }

  private latestAttempt(taskID: string): ReviewAttempt | undefined {
    return (
      this.repository.read((db) =>
        db
          .query<ReviewAttempt, [string, string]>(
            `SELECT ${REVIEW_ATTEMPT_COLUMNS}
             FROM runner_attempts a
             WHERE a.project_directory=? AND a.task_id=?
             ORDER BY a.started_at DESC,a.number DESC,a.id DESC
             LIMIT 1`,
          )
          .get(this.repository.projectDirectory, taskID),
      ) ?? undefined
    )
  }

  private latestTaskArtifact(
    taskID: string,
  ): { planID: string; attempt: ReviewAttempt } | undefined {
    const latest = this.repository.read((db) =>
      db
        .query<ReviewAttempt, [string, string]>(
          `SELECT ${REVIEW_ATTEMPT_COLUMNS}
           FROM runner_attempts a
           WHERE a.project_directory=? AND a.task_id=? AND a.artifact IS NOT NULL
           ORDER BY a.started_at DESC,a.number DESC,a.id DESC
           LIMIT 1`,
        )
        .get(this.repository.projectDirectory, taskID),
    )
    return latest ? { planID: latest.plan_id, attempt: latest } : undefined
  }

  private previousAttempt(attempt: ReviewAttempt): ReviewAttempt | undefined {
    return (
      this.repository.read((db) =>
        db
          .query<ReviewAttempt, [string, string, string, number]>(
            `SELECT ${REVIEW_ATTEMPT_COLUMNS}
             FROM runner_attempts a
             WHERE a.project_directory=? AND a.plan_id=? AND a.task_id=? AND a.number<?
             ORDER BY a.number DESC,a.started_at DESC,a.id DESC
             LIMIT 1`,
          )
          .get(this.repository.projectDirectory, attempt.plan_id, attempt.task_id, attempt.number),
      ) ?? undefined
    )
  }

  private taskChainBase(attempt: ReviewAttempt): string {
    const chain = [attempt]
    let current = attempt
    for (;;) {
      const previous = this.previousAttempt(current)
      if (!previous) break
      chain.push(previous)
      if (previous.artifact !== current.base_commit) break
      current = previous
    }
    return taskChainBase(attempt, chain)
  }

  private attemptForArtifact(
    planID: string,
    taskID: string,
    artifact: string,
  ): ReviewAttempt | undefined {
    return (
      this.repository.read((db) =>
        db
          .query<ReviewAttempt, [string, string, string, string]>(
            `SELECT ${REVIEW_ATTEMPT_COLUMNS}
             FROM runner_attempts a
             WHERE a.project_directory=? AND a.plan_id=? AND a.task_id=? AND a.artifact=?
             ORDER BY a.number DESC,a.started_at DESC,a.id DESC
             LIMIT 1`,
          )
          .get(this.repository.projectDirectory, planID, taskID, artifact),
      ) ?? undefined
    )
  }

  private async planComparison(
    plan: PlanRow,
    body: z.infer<typeof PlanInput>,
    nodes: NodeRow[],
    signal: AbortSignal,
  ): Promise<ResolvedPlan> {
    if (!plan.artifact) throw new Error("Plan has no combined artifact to compare")
    const taskFiles: Record<string, string[]> = {}
    for (const node of nodes) {
      signal.throwIfAborted()
      if (!node.artifact) continue
      const attempt = this.attemptForArtifact(plan.id, node.task_id, node.artifact)
      if (!attempt) continue
      const base = this.taskChainBase(attempt)
      const changes = await diffHunks(this.repository.projectDirectory, base, node.artifact, signal)
      taskFiles[node.task_id] = [...changes.keys()].sort()
    }
    const dependencies = body.dependencies.map((dependency) => ({
      prerequisite: dependency.prerequisite,
      successor: dependency.successor,
    }))
    return { base: body.baseCommit, head: plan.artifact, nodes, taskFiles, dependencies }
  }
}

function attemptFollows(candidate: ReviewAttempt, baseline: ReviewAttempt): boolean {
  if (candidate.started_at !== baseline.started_at)
    return candidate.started_at > baseline.started_at
  if (candidate.number !== baseline.number) return candidate.number > baseline.number
  return candidate.id.localeCompare(baseline.id) > 0
}
