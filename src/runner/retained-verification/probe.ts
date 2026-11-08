import type { RetainedVerification } from "./schema.ts"

export type RetainedProbeBasis = {
  candidate: { revision: string; workspace: string }
  inputs: { recordID: string; revision: string }
  environment: { recordID: string; revision: string }
}

/** Current probe basis is deterministic and bound to one retained operation phase. */
export function retainedVerificationProbeBasis(
  operation: RetainedVerification,
  phase: "task" | "combined",
): RetainedProbeBasis {
  const workspace = phase === "task" ? operation.taskWorkspace : operation.combinedWorkspace
  if (!workspace) throw new Error(`Retained ${phase} candidate checkout has not been reserved`)
  const artifact = phase === "task" ? operation.artifact : operation.combinedArtifact
  if (!artifact) throw new Error(`Retained ${phase} candidate is not available yet`)
  const revision = `${operation.id}:${operation.generation}:${phase}`
  return {
    candidate: { revision: artifact, workspace },
    inputs: {
      recordID: `retained-verification:${operation.id}:inputs`,
      revision,
    },
    environment: {
      recordID: `retained-verification:${operation.id}:environment`,
      revision,
    },
  }
}
