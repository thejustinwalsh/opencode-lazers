import { expect, test } from "bun:test"
import { validProposal } from "../../test/proposal.ts"
import { GetOutput } from "./contract.ts"
import { taskInstructions } from "./instructions.ts"
import { TaskAdviceRecord } from "./advice.ts"
import { parseProfile } from "../projects/profile.ts"
import type { ActiveProfile } from "../projects/profile-store.ts"

const detail = GetOutput.parse({
  status: "found",
  classification: {
    revision: 1,
    classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
    provenance: {
      kind: "embedded",
      sessionID: "owner",
      createdAt: "2026-10-31T12:00:00.000Z",
    },
  },
  classificationHistory: [
    {
      revision: 1,
      classification: { taxonomy: "task-kind/v1", primaryKind: "feature-implementation" },
      provenance: {
        kind: "embedded",
        sessionID: "owner",
        createdAt: "2026-10-31T12:00:00.000Z",
      },
    },
  ],
  advice: null,
  reference: "LZ-1",
  task: {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    status: "submitted",
    createdAt: "2026-10-31T12:00:00.000Z",
    provenance: {
      projectID: "project",
      projectDirectory: "/repo",
      workspaceDirectory: "/repo",
      sessionID: "owner",
      startingRevision: { kind: "git", commit: "0".repeat(40) },
    },
    proposal: {
      ...validProposal(),
      guidance: "Reuse the existing task read boundary; keep advice advisory.",
      context: [{ reference: "README.md", revision: "abc123" }],
      constraints: ["Preserve transaction atomicity because task submission spans two writes."],
      requirements: {
        ...validProposal().requirements,
        policyReference: "Obsolete boilerplate: required skills must resolve before workers run.",
        skills: [
          "sqlite — Reuse the existing transaction helper for atomic writes.",
          "legacy-skill",
          "old-header\nSECRET_SKILL_BODY_CANARY",
        ],
      },
    },
  },
})

function instructionsForVerification(
  verification: Array<{
    id: string
    command: string
    timeoutMs?: number
    inactivityTimeoutMs?: number
    hardTimeoutMs?: number
  }>,
) {
  if (detail.status !== "found") throw new Error("Test task fixture is not found")
  return taskInstructions(
    GetOutput.parse({
      ...detail,
      task: {
        ...detail.task,
        proposal: { ...detail.task.proposal, verification },
      },
    }),
  )
}

test("task instructions preserve goal, acceptance, boundaries, guidance, verification, and sources", () => {
  const instructions = taskInstructions(detail)

  expect(instructions).toStartWith(
    `# Task ${detail.status === "found" ? detail.task.id : ""} (LZ-1)`,
  )
  expect(instructions).toContain("Keep submitted tasks after the plugin restarts")
  expect(instructions).toContain("## Done when\n- reopen: A task can be retrieved")
  expect(instructions).toContain("Evidence: tests")
  expect(instructions).toContain("## Write scope\n- src/**\n- README.md")
  expect(instructions).toContain("## Exclusions\n- Do not dispatch workers")
  expect(instructions).toContain(
    "## Constraints\n- Preserve transaction atomicity because task submission spans two writes.",
  )
  expect(instructions).toContain("## Implementation guidance (advisory)")
  expect(instructions).toContain("keep advice advisory")
  expect(instructions).toContain(
    "## Verification\n- tests: bun test (inactivity allowance: project default (resolved by runtime at execution); hard backstop: project default (resolved by runtime at execution); legacy timeout: 60000ms (historical; not used for execution))",
  )
  expect(instructions).toContain("## Context references\n- README.md (revision abc123)")
  expect(instructions).toContain("## Optional skill suggestions")
  expect(instructions).toContain(
    "- sqlite: Reuse the existing transaction helper for atomic writes.",
  )
  expect(instructions).toContain(
    "- legacy-skill: Description unavailable (legacy suggestion stores only a name).",
  )
  expect(instructions).toContain(
    "- old-header: Description unavailable (legacy suggestion stores only a name).",
  )
  expect(instructions).not.toContain("Required skills")
  expect(instructions).not.toContain("SECRET_SKILL_BODY_CANARY")
  expect(instructions).not.toContain("Risk:")
  expect(instructions).not.toContain("Policy:")
  expect(instructions).not.toContain("Obsolete boilerplate")
  expect(instructions).not.toContain("lz-project-index")
  expect(instructions.indexOf("## Done when")).toBeLessThan(instructions.indexOf("## Constraints"))
  expect(instructions).not.toContain('"proposal"')
})

test("task instructions retain readable missing-task and unavailable-revision outcomes", () => {
  expect(taskInstructions(detail)).not.toContain("Task-attached advice")
  expect(taskInstructions({ status: "not_found" })).toBe("Task not_found.")
  expect(taskInstructions({ status: "revision_unavailable", revision: 1 })).toBe(
    "Task revision_unavailable.",
  )
})

test("worker instructions describe authored timing and unresolved project defaults truthfully", () => {
  const omitted = instructionsForVerification([{ id: "tests", command: "bun test" }])
  expect(omitted).toContain(
    "tests: bun test (inactivity allowance: project default (resolved by runtime at execution); hard backstop: project default (resolved by runtime at execution))",
  )
  expect(omitted).not.toMatch(/undefinedms|NaN/)
  expect(omitted).not.toContain("legacy timeout")

  const legacyOnly = instructionsForVerification([
    { id: "tests", command: "bun test", timeoutMs: 12_345 },
  ])
  expect(legacyOnly).toContain(
    "inactivity allowance: project default (resolved by runtime at execution)",
  )
  expect(legacyOnly).toContain("hard backstop: project default (resolved by runtime at execution)")
  expect(legacyOnly).toContain("legacy timeout: 12345ms (historical; not used for execution)")

  const dual = instructionsForVerification([
    {
      id: "tests",
      command: "bun test",
      timeoutMs: 60_000,
      inactivityTimeoutMs: 15_000,
      hardTimeoutMs: 90_000,
    },
  ])
  expect(dual).toContain("inactivity allowance: 15000ms (authored)")
  expect(dual).toContain("hard backstop: 90000ms (authored)")
  expect(dual).toContain("legacy timeout: 60000ms (historical; not used for execution)")

  const partial = instructionsForVerification([
    { id: "tests", command: "bun test", inactivityTimeoutMs: 30_000 },
  ])
  expect(partial).toContain("inactivity allowance: 30000ms (authored)")
  expect(partial).toContain("hard backstop: project default (resolved by runtime at execution)")
  expect(partial).not.toMatch(/undefinedms|NaN/)
})

test("superseded task instructions retrieve the sole replacement without presenting retired obligations", () => {
  const replacementID = "d9ceb8a7-6b31-4b04-b6bc-fb4129c73538"
  const superseded = GetOutput.parse({
    ...detail,
    disposition: {
      id: 25,
      taskID: detail.status === "found" ? detail.task.id : "",
      requestID: "lz181-superseded-by-lz199",
      disposition: "superseded",
      reason:
        "LZ-199 is the sole current contract; contradictory historical requirements are retired.",
      evidence: [{ kind: "human", reference: "review:current-contract" }],
      relatedTaskIDs: [replacementID],
      sessionID: "architect",
      agent: "architect",
      createdAt: "2026-11-09T04:36:51.927Z",
    },
  })

  const historicalInstructions = taskInstructions(superseded)
  expect(historicalInstructions).toContain("superseded, not an active implementation contract")
  expect(historicalInstructions).toContain(replacementID)
  expect(historicalInstructions).toContain("Retrieve it with `lz-get-task`")
  expect(historicalInstructions).toContain('`format: "structured"`')
  expect(historicalInstructions).toContain("review:current-contract")
  expect(historicalInstructions).not.toContain("Keep submitted tasks after the plugin restarts")
  expect(historicalInstructions).not.toContain("## Done when")
  expect(historicalInstructions).not.toContain("## Constraints")
  expect(historicalInstructions).not.toContain("## Verification")

  const currentObjective =
    "Complete the preserved repair under one current contract without retired baseline gates."
  const current = GetOutput.parse({
    ...detail,
    task: {
      ...(detail.status === "found" ? detail.task : {}),
      id: replacementID,
      proposal: {
        ...(detail.status === "found" ? detail.task.proposal : {}),
        objective: currentObjective,
        acceptance: [
          {
            id: "current-contract",
            assertion: "The current repair behavior and checks pass without retired gates.",
            evidence: [{ kind: "artifact", reference: "src/runner/runtime.ts" }],
          },
        ],
        constraints: ["Use only the LZ-199 current contract."],
      },
    },
    reference: "LZ-199",
  })
  const currentInstructions = taskInstructions(current)
  expect(currentInstructions).toContain(currentObjective)
  expect(currentInstructions).toContain("Use only the LZ-199 current contract.")
  expect(currentInstructions).toContain("current-contract: The current repair behavior")
})

test("task instructions render only concise effective advice with its provenance and inert references", () => {
  const earlier = TaskAdviceRecord.parse({
    projectDirectory: "/repo",
    taskID: "11111111-1111-4111-8111-111111111111",
    specRevision: 1,
    requestID: "advice-1",
    revision: 1,
    findings: ["Old finding that should remain history only."],
    implementationAdvice: ["Old advice that should remain history only."],
    references: [],
    provenance: {
      sessionID: "old-session",
      agent: "architect",
      createdAt: "2026-10-31T12:00:00.000Z",
    },
  })
  const current = TaskAdviceRecord.parse({
    ...earlier,
    requestID: "advice-2",
    revision: 2,
    findings: ["Read the existing transaction seam before adding persistence."],
    implementationAdvice: ["Keep the attachment separate from the immutable task body."],
    references: [
      {
        kind: "mini-skill",
        reference: "sqlite-transactions",
        description: "Optional notes; retrieve only if useful.",
      },
    ],
    provenance: {
      sessionID: "replacement-architect",
      agent: "architect",
      createdAt: "2026-11-04T12:00:00.000Z",
    },
  })
  const detailWithAdvice = GetOutput.parse({
    ...detail,
    advice: {
      current,
      history: [earlier, current],
      historyCount: 2,
      historyTruncated: false,
    },
  })
  const instructions = taskInstructions(detailWithAdvice)

  expect(instructions).toContain("## Task-attached advice (advisory, revision 2)")
  expect(instructions).not.toContain("session replacement-architect")
  expect(instructions).toContain("Read the existing transaction seam")
  expect(instructions).toContain("Keep the attachment separate")
  expect(instructions).toContain("mini-skill: sqlite-transactions")
  expect(instructions).toContain("Optional references")
  expect(instructions).not.toContain("Old finding")
  expect(instructions).not.toContain("Old advice")
  expect(instructions).not.toContain('"history"')
})

test("task instructions show the scope model: edit, create with purpose, and protected", () => {
  if (detail.status !== "found") throw new Error("fixture task missing")
  const scoped = {
    ...detail,
    task: {
      ...detail.task,
      proposal: {
        ...detail.task.proposal,
        createScope: [{ path: "src/runner/queue-limit.ts", purpose: "the queue limit rule" }],
        protectedScope: ["src/audit/**"],
      },
    },
  }
  const instructions = taskInstructions(scoped)
  expect(instructions).toContain("## Write scope\n- src/**\n- README.md")
  expect(instructions).toContain(
    "## Expected new files and folders (create)\n- src/runner/queue-limit.ts — the queue limit rule",
  )
  expect(instructions).toContain("## Protected (do not touch)\n- src/audit/**")
  expect(instructions).toContain("say why in one line in your final message")
})

function activeCargoProfile(unprovenFix = false): ActiveProfile {
  const parsed = parseProfile({
    toolchains: ["cargo"],
    verify: [
      { id: "fmt", command: "cargo fmt --check" },
      { id: "tests", command: "cargo test --locked" },
    ],
    fix: [{ command: "cargo fmt --", files: ["**/*.rs"] }],
    source: { include: ["src/**/*.rs"] },
  })
  if (!parsed.ok) throw new Error("fixture profile is invalid")
  const proof = (key: string, outcome: "proven" | "failed", exitCode: number) =>
    [
      key,
      {
        key,
        command: "x",
        outcome,
        exitCode,
        timedOut: false,
        durationMs: 1,
        stdoutTail: "",
        stderrTail: "",
        ranAt: 1,
      },
    ] as const
  return {
    revisionID: 1,
    revision: 1,
    projectKey: "k",
    profile: parsed.profile,
    activatedAt: 1,
    proofs: new Map([
      proof("verify:fmt", "proven", 0),
      proof("verify:tests", unprovenFix ? "failed" : "proven", unprovenFix ? 101 : 0),
      proof("fix:0", "proven", 0),
    ]),
  }
}

test("with no profile the instructions are unchanged, and with one they name the profile's commands", () => {
  const without = taskInstructions(detail)
  expect(taskInstructions(detail, undefined)).toBe(without)
  expect(without).toContain("Run the project's formatter and linter automatic fixes")
  const withProfile = taskInstructions(detail, activeCargoProfile())
  expect(withProfile).toContain("## Project verification (profile revision 1)")
  expect(withProfile).toContain("- tests: cargo test --locked")
  expect(withProfile).toContain("cargo fmt --")
  expect(withProfile).not.toContain("bun run verify")
  expect(withProfile.startsWith(without.split("\n\nRun the project's formatter")[0]!)).toBe(true)
})

test("an unproven verify command is marked with its exit code", () => {
  expect(taskInstructions(detail, activeCargoProfile(true))).toContain(
    "- tests: cargo test --locked (unproven: exit 101)",
  )
})
