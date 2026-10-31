import type { TaskProposal } from "../src/task.ts"

export function validProposal(): TaskProposal & { limits: NonNullable<TaskProposal["limits"]> } {
  return {
    objective: "Keep submitted tasks after the plugin restarts",
    exclusions: ["Do not dispatch workers"],
    constraints: ["Use plugin-owned SQLite storage"],
    assumptions: [],
    writeScope: ["src/**", "README.md"],
    context: [{ reference: "README.md", revision: null }],
    acceptance: [
      {
        id: "reopen",
        assertion: "A task can be retrieved after reopening the database",
        evidence: [{ kind: "verification", verificationID: "tests" }],
      },
    ],
    requirements: {
      capabilities: ["sqlite"],
      skills: [],
      risk: "low",
      policyReference: "AGENTS.md",
    },
    verification: [{ id: "tests", command: "bun test", timeoutMs: 60_000 }],
    limits: {
      maxTokens: 20_000,
      maxEstimatedCostUsd: 2,
      maxElapsedMs: 1_200_000,
      maxToolCalls: 40,
      maxProviderRetries: 0,
      maxRepairAttempts: 1,
    },
  }
}
