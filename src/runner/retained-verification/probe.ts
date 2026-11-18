import type { RetainedVerification } from "./schema.ts"

export type RetainedProbeBasis = {
  candidate: { revision: string; workspace: string }
  inputs: { recordID: string; revision: string }
  environment: { recordID: string; revision: string }
}

/** Current probe basis is deterministic and bound to one retained operation. */
export function retainedVerificationProbeBasis(
  operation: RetainedVerification,
  phase: "task",
): RetainedProbeBasis {
  const workspace = operation.taskWorkspace
  if (!workspace) throw new Error(`Retained ${phase} candidate checkout has not been reserved`)
  const revision = `${operation.id}:${phase}`
  return {
    candidate: { revision: operation.artifact, workspace },
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
