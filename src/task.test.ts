import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  TaskProposalSchema,
  TaskSpecSchema,
  TaskSubmissionSchema,
  taskProposalJSONSchema,
} from "./task.ts"
import { validProposal } from "../test/proposal.ts"

test("submission keys are required transport identity, bounded and never normalized", () => {
  const schema = z.toJSONSchema(TaskSubmissionSchema, { io: "input" })
  expect(schema.required).toContain("idempotencyKey")
  expect(schema.properties?.idempotencyKey).toMatchObject({
    type: "string",
    minLength: 1,
    maxLength: 200,
    pattern: "\\S",
  })
  for (const idempotencyKey of [undefined, null, 1, {}, "", " \t\n", "a".repeat(201)]) {
    const result = TaskSubmissionSchema.safeParse({ ...validProposal(), idempotencyKey })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["idempotencyKey"])
  }
  for (const idempotencyKey of ["a", "a".repeat(200), " key ", "é", "e\u0301"]) {
    expect(TaskSubmissionSchema.parse({ ...validProposal(), idempotencyKey }).idempotencyKey).toBe(
      idempotencyKey,
    )
  }
  expect(TaskProposalSchema.safeParse(validProposal()).success).toBe(true)
  expect(TaskProposalSchema.safeParse({ ...validProposal(), idempotencyKey: "key" }).success).toBe(
    false,
  )
  expect(
    TaskSubmissionSchema.safeParse({
      ...validProposal(),
      idempotencyKey: "key",
      verification: [],
    }).success,
  ).toBe(false)
})

describe("task proposals", () => {
  test("accepts a scoped task and emits strict JSON Schema from Zod", () => {
    expect(TaskProposalSchema.parse(validProposal())).toEqual(validProposal())
    expect(taskProposalJSONSchema.type).toBe("object")
    expect(taskProposalJSONSchema.additionalProperties).toBe(false)
    expect(taskProposalJSONSchema.required).toContain("limits")
  })

  test("rejects drafts, unknown fields, empty intent, and missing evidence or limits", () => {
    for (const change of [
      { objective: " " },
      { questions: ["Which database?"] },
      { acceptance: [] },
      { limits: undefined },
      { acceptance: [{ id: "a", assertion: "Works", evidence: [] }] },
    ]) {
      expect(TaskProposalSchema.safeParse({ ...validProposal(), ...change }).success).toBe(false)
    }
  })

  test("rejects scope paths that escape or ambiguously redefine the repository boundary", () => {
    for (const path of [
      "../secret",
      "src/../../secret",
      "/tmp/file",
      "C:/file",
      "src\\file",
      "!src/**",
      "./src",
      "src/..",
      "~/file",
    ]) {
      expect(TaskProposalSchema.safeParse({ ...validProposal(), writeScope: [path] }).success).toBe(
        false,
      )
    }
  })

  test("exported path pattern works without Unicode regex flags used outside JSON Schema", () => {
    const schema = taskProposalJSONSchema as unknown as {
      properties: { writeScope: { items: { pattern: string } } }
    }
    const wirePattern = new RegExp(schema.properties.writeScope.items.pattern)
    for (const path of ["src/安全.ts", "src/**", "src/file.ts"]) {
      expect(wirePattern.test(path)).toBe(true)
      expect(TaskProposalSchema.safeParse({ ...validProposal(), writeScope: [path] }).success).toBe(
        true,
      )
    }
    for (const path of [
      "src/\u0000file",
      "src/\u001ffile",
      "src/\u007ffile",
      "src/\u0085file",
      "../secret",
    ]) {
      expect(wirePattern.test(path)).toBe(false)
      expect(TaskProposalSchema.safeParse({ ...validProposal(), writeScope: [path] }).success).toBe(
        false,
      )
    }
  })

  test("rejects duplicate identifiers and missing verification references", () => {
    const proposal = validProposal()
    expect(
      TaskProposalSchema.safeParse({
        ...proposal,
        acceptance: [...proposal.acceptance, ...proposal.acceptance],
      }).success,
    ).toBe(false)
    expect(
      TaskProposalSchema.safeParse({
        ...proposal,
        verification: [...proposal.verification, ...proposal.verification],
      }).success,
    ).toBe(false)
    expect(TaskProposalSchema.safeParse({ ...proposal, verification: [] }).success).toBe(false)
  })

  test("requires finite explicit budgets and at most one repair", () => {
    for (const limits of [
      { maxTokens: 0 },
      { maxElapsedMs: -1 },
      { maxToolCalls: 1.5 },
      { maxEstimatedCostUsd: Infinity },
      { maxRepairAttempts: 2 },
      { maxProviderRetries: -1 },
    ]) {
      expect(
        TaskProposalSchema.safeParse({
          ...validProposal(),
          limits: { ...validProposal().limits, ...limits },
        }).success,
      ).toBe(false)
    }
  })
})

test("submitted envelopes distinguish unborn provenance from a missing revision", () => {
  const task = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    revision: 1,
    status: "submitted",
    createdAt: new Date().toISOString(),
    provenance: {
      projectID: "local",
      projectDirectory: "/repo",
      workspaceDirectory: "/repo",
      sessionID: "session",
      startingRevision: { kind: "unborn" },
    },
    proposal: validProposal(),
  }
  expect(TaskSpecSchema.safeParse(task).success).toBe(true)
  expect(TaskSpecSchema.safeParse({ ...task, status: "ready" }).success).toBe(false)
  expect(
    TaskSpecSchema.safeParse({
      ...task,
      provenance: { ...task.provenance, startingRevision: null },
    }).success,
  ).toBe(false)
})
