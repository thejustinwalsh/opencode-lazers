import type { TaskRepository } from "../../storage.ts"
import { fingerprint } from "../../identity.ts"
import { CodeReviewComparisonSchema, CODE_REVIEW_CONTRACT_VERSION } from "../contract.ts"
import { blobBatch, diffHunks, isConfidentialSourcePath, treeFiles } from "../comparisons/git.ts"
import type { ComparisonBlob, ComparisonFile } from "../comparisons/store.ts"
import { allPairRows, gitFileEntry } from "../comparisons/inventory.ts"
import type { CodeReviewComparison } from "../contract.ts"

export type PreparedIntegrationComparison = {
  comparison: CodeReviewComparison
  files: ComparisonFile[]
  blobs: ComparisonBlob[]
}

export async function prepareIntegrationComparison(input: {
  repository: TaskRepository
  projectID: string
  integrationID: string
  taskID: string
  planID: string
  attemptID: string | null
  baseRevision: string
  headRevision: string
  capturedAt: number
}): Promise<PreparedIntegrationComparison> {
  const task = input.repository.get(input.taskID)
  if (!task) throw new Error("Integration task is unavailable in this project")
  const root = input.repository.projectDirectory
  const [baseTree, headTree, hunks] = await Promise.all([
    treeFiles(root, input.baseRevision),
    treeFiles(root, input.headRevision),
    diffHunks(root, input.baseRevision, input.headRevision),
  ])
  const baseEntries = new Map([...baseTree].map(([path, file]) => [path, gitFileEntry(file)]))
  const headEntries = new Map([...headTree].map(([path, file]) => [path, gitFileEntry(file)]))
  const files = allPairRows(baseEntries, headEntries, { before: "base", after: "head" }, hunks)
  const blobsByID = new Map<string, Uint8Array>()
  for (const file of files) {
    if (
      !file.changed ||
      !file.objectID ||
      file.kind === "binary" ||
      file.kind === "symlink" ||
      file.kind === "submodule" ||
      isConfidentialSourcePath(file.path)
    )
      continue
    blobsByID.set(file.objectID, new Uint8Array())
  }
  const retained = await blobBatch(root, [...blobsByID.keys()])
  const blobs = [...retained].map(([id, content]) => ({ id, content }))
  const identity = {
    version: CODE_REVIEW_CONTRACT_VERSION,
    projectID: input.projectID,
    taskID: input.taskID,
    planID: input.planID,
    attemptID: input.attemptID,
    mode: "since" as const,
    baseRevision: input.baseRevision,
    headRevision: input.headRevision,
    snapshotID: null,
    capturedAt: input.capturedAt,
    attribution: "committed" as const,
  }
  const comparisonID = fingerprint({ ...identity, integrationID: input.integrationID })
  const paths = new Set(files.map((file) => file.path))
  const changedPaths = new Set(files.filter((file) => file.changed).map((file) => file.path))
  const comparison = CodeReviewComparisonSchema.parse({
    identity: { ...identity, comparisonID },
    available: true,
    unavailableReason: null,
    fileCount: paths.size,
    changedCount: changedPaths.size,
    sides: ["base", "head"],
    sourceName: "codeReview.files",
    taskReference: input.repository.referenceFor(task.id) ?? task.id,
    taskTitle: task.proposal.objective.slice(0, 120),
    planContext: null,
  })
  return { comparison, files, blobs }
}
